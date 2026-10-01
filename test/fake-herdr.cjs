#!/usr/bin/env node
const { readFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const dir = process.env.FAKE_HERDR_DIR;
const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(args) + '\n');
const key = args.slice(0, 2).join(' ');
const ok = result => console.log(JSON.stringify({ result }));
const fail = (code, message) => { console.error(JSON.stringify({ error: { code, message } })); process.exit(1); };
if (key === 'agent list') {
  if (state.listError) fail('server_error', 'server unavailable');
  ok({ agents: state.agents || [] });
} else if (key === 'pane current') ok({ pane: { pane_id: 'w1:p1' } });
else if (key === 'pane layout') ok({ layout: state.layout });
else if (key === 'pane split') ok({ pane: { pane_id: 'w1:p9' } });
else if (key === 'tab create') ok({ root_pane: { pane_id: 'w1:p8' } });
else if (key === 'agent start') {
  if (state.startError) fail(state.startError, 'start failed');
  ok({});
} else if (key === 'agent prompt') {
  if (state.checkBoard) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(state.checkBoard);
    const note = db.prepare('SELECT * FROM notes ORDER BY rowid DESC LIMIT 1').get();
    db.close();
    if (!note || !args[3].includes(note.message)) fail('not_persisted', 'notification preceded board write');
  }
  const finish = () => {
    if (state.promptError || args[2] === 'blocked') fail(state.promptError || 'agent_blocked', 'blocked at dialog');
    ok({});
  };
  if (state.delay) setTimeout(finish, state.delay); else finish();
} else if (key === 'pane read') console.log('Startup diagnostics');
else ok({});
