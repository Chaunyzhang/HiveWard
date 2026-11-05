import test from 'node:test'
import assert from 'node:assert/strict'
import { createExitIp, isDualStackSplit, parseIpInfo, probeExitIp } from './exit-ip.mjs'
import { parseMacHardware, parseWindowsHardware } from './machine-model.mjs'

test('parses ipinfo.io and ipapi.co replies; rejects junk', () => {
  assert.deepEqual(
    parseIpInfo(
      JSON.stringify({
        ip: '38.244.42.13',
        city: 'Los Angeles',
        region: 'California',
        country: 'US',
        org: 'AS174 Cogent Communications'
      })
    ),
    {
      ip: '38.244.42.13',
      city: 'Los Angeles',
      region: 'California',
      country: 'US',
      org: 'AS174 Cogent Communications'
    }
  )
  assert.equal(
    parseIpInfo(JSON.stringify({ ip: '2001:db8::1', country_code: 'jp', country: 'Japan' }))
      .country,
    'JP'
  )
  assert.equal(parseIpInfo('not json'), null)
  assert.equal(parseIpInfo(JSON.stringify({ ip: 'example.com' })), null)
})

test('dual-stack split only when IPv6 leaves from another country or region', () => {
  const la = { ip: '1.1.1.1', country: 'US', region: 'California' }
  assert.equal(isDualStackSplit(la, { ip: '2001::1', country: 'US', region: 'California' }), false)
  assert.equal(isDualStackSplit(la, { ip: '2408::1', country: 'CN', region: 'Beijing' }), true)
  assert.equal(isDualStackSplit(la, null), false)
})

test('probe asks -4 and -6 separately and ignores a family that came back as the other', async () => {
  const calls = []
  const run = async ({ args, env }) => {
    calls.push({ family: args[1], env })
    const ip = args[1] === '-4' ? '38.244.42.13' : '38.244.42.13'
    return { code: 0, stdout: JSON.stringify({ ip, country: 'US', region: 'California' }) }
  }
  const result = await probeExitIp({ env: { HTTPS_PROXY: 'http://127.0.0.1:7890' } }, run)
  assert.equal(result.v4.ip, '38.244.42.13')
  // -6 拿回的是 IPv4：说明 IPv6 没出去，不算
  assert.equal(result.v6, null)
  assert.equal(result.split, false)
  assert.ok(calls.some((c) => c.family === '-4') && calls.some((c) => c.family === '-6'))
  // 用的是 Agent 的登录 shell 环境（代理变量）
  assert.equal(calls[0].env.HTTPS_PROXY, 'http://127.0.0.1:7890')
})

test('current() returns immediately, measures in the background and caches 10 minutes', async () => {
  let t = 0
  let probes = 0
  const exitIp = createExitIp({
    capture: async () => ({ env: {}, shell: '/bin/zsh' }),
    probe: async () => {
      probes++
      return { v4: { ip: '1.1.1.1', country: 'US' }, v6: null, split: false }
    },
    now: () => t
  })
  assert.equal(exitIp.current(), null)
  await exitIp.refresh()
  assert.equal(exitIp.current().v4.ip, '1.1.1.1')
  assert.equal(probes, 1)
  t += 9 * 60 * 1000
  exitIp.current()
  assert.equal(probes, 1)
  t += 2 * 60 * 1000
  exitIp.current()
  await exitIp.refresh()
  assert.ok(probes >= 2)
})

test('shell environment failure is reported, not thrown', async () => {
  const exitIp = createExitIp({
    capture: async () => {
      throw new Error('shell_environment_unavailable')
    }
  })
  const result = await exitIp.refresh()
  assert.equal(result.reason, 'shell_environment_unavailable')
  assert.equal(result.v4, null)
})

test('machine model: Mac name + chip, Windows vendor + model without placeholders', () => {
  assert.equal(
    parseMacHardware(
      JSON.stringify({
        SPHardwareDataType: [{ machine_name: 'MacBook Pro', chip_type: 'Apple M3 Pro' }]
      })
    ),
    'MacBook Pro · Apple M3 Pro'
  )
  assert.equal(
    parseWindowsHardware(
      JSON.stringify({ Manufacturer: 'Micro-Star International Co., Ltd.', Model: 'MS-7C02' })
    ),
    'Micro-Star International Co., Ltd. MS-7C02'
  )
  assert.equal(
    parseWindowsHardware(
      JSON.stringify({ Manufacturer: 'System manufacturer', Model: 'System Product Name' })
    ),
    null
  )
  assert.equal(parseMacHardware('{}'), null)
})
