// A startHivewardd test that fails partway must not leave latches closed: later tests in the worker would wait 10 s.
import { afterEach } from 'vitest'
import { _resetHivewarddFeatureReadinessForTests } from '../../src/main/runtime/rpc/hivewardd-feature-readiness'

afterEach(() => {
  _resetHivewarddFeatureReadinessForTests()
})
