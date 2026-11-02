// Keep the imported standalone project on its own tooling; never reformat the handoff.
module.exports = { '*.mjs': (files) => files.map((file) => `node --check ${JSON.stringify(file)}`) }
