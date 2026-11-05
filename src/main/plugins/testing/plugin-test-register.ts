/** `node --import hiveward-test-register.mjs`: installs the plugin test hooks shipped beside it. */
import { register } from 'node:module'

register('./hiveward-test-hooks.mjs', import.meta.url)
