#!/usr/bin/env node
const { readFileSync, appendFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const dir = process.env.FAKE_HERDR_DIR;
const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(args) + '\n');
const key = args.slice(0, 2).join(' ');
if (state.malformed === key) { console.log('{"result":{}}'); process.exit(0); }
if (state.emptyReply === key) process.exit(0);
const ok = result => console.log(JSON.stringify({ result }));
const save = () => writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
const fail = (code, message) => { console.error(JSON.stringify({ error: { code, message } })); process.exit(1); };
if (key === 'agent list') {
  if (state.listError) fail(state.listError === true ? 'server_error' : state.listError, 'server unavailable');
  ok({ agents: state.agents || [] });
} else if (key === 'agent get') {
  if (state.getError) fail(state.getError, 'get failed');
  const agent = state.agents.find(a => a.name === args[2] || a.pane_id === args[2]);
  if (!agent) fail('agent_not_found', 'not addressable');
  ok({ agent });
} else if (key === 'agent rename') {
  const own = state.agents.find(a => a.pane_id === args[2]);
  const error = state.renameErrors?.shift();
  if (!error || state.renameSucceeded) own.name = state.confirmedName || args[3];
  if (error === 'agent_name_taken') state.agents.push({ name: args[3], pane_id: 'w1:p7' });
  save();
  if (error) fail(error, 'rename failed');
  ok({ agent: own });
} else if (key === 'pane current') ok({ pane: { pane_id: 'w1:p1' } });
else if (key === 'pane layout') ok({ layout: state.layout });
else if (key === 'pane split') ok({ pane: { pane_id: 'w1:p9' } });
else if (key === 'tab create') ok({ root_pane: { pane_id: 'w1:p8' } });
else if (key === 'agent start') {
  if (state.startError) fail(state.startError, 'start failed');
  const i = args.indexOf('--session');
  state.agents.push({ name: args[2], pane_id: args[args.indexOf('--pane') + 1], agent: 'pi', agent_status: 'idle', agent_session: { kind: 'path', value: i >= 0 ? args[i + 1] : '/tmp/test-session.jsonl' } });
  save(); ok({});
} else if (key === 'agent prompt') {
  if (state.checkBoard) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(state.checkBoard);
    const note = db.prepare('SELECT * FROM notes ORDER BY rowid DESC LIMIT 1').get();
    db.close();
    if (!note || !args[3].includes(note.message) || !args[3].includes(state.checkBoard)) fail('not_persisted', 'notification preceded board write or missing source path');
  }
  const finish = () => {
    if (state.promptError || args[2] === 'blocked') fail(state.promptError || 'agent_blocked', 'prompt failed');
    ok({ type: 'agent_prompted' });
  };
  if (state.delay) setTimeout(finish, state.delay); else finish();
} else if (key === 'pane read') console.log('Startup diagnostics');
else ok({});
