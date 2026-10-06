#!/usr/bin/env node
const { readFileSync, appendFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const dir = process.env.FAKE_HERDR_DIR;
const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
// The pi integration probe runs at every session start; answer it without recording a call.
if (args[0] === 'integration' && args[1] === 'status') { console.log(state.integration || 'pi: current (v9)'); process.exit(0); }
if (args[0] === 'integration' && args[1] === 'install') { appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(args) + '\n'); console.log('installed'); process.exit(0); }
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(args) + '\n');
const key = args.slice(0, 2).join(' ');
if (state.malformed === key) { console.log('{"result":{}}'); process.exit(0); }
if (state.emptyReply === key) process.exit(0);
const ok = result => console.log(JSON.stringify({ result }));
const save = () => writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
const fail = (code, message) => { console.error(JSON.stringify({ error: { code, message } })); process.exit(1); };
if (key === 'agent list') {
  if (state.listMarker) writeFileSync(state.listMarker, 'started');
  if (state.delayList) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.delayList);
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
} else if (key === 'pane current') ok({ pane: { pane_id: 'w1:p1', workspace_id: 'w1' } });
else if (key === 'pane report-metadata') {
  if (state.metadataError) fail(state.metadataError, 'metadata failed');
  const own = state.agents.find(a => a.pane_id === args[2]);
  if (own) {
    if (args.includes('--title')) own.title = Array.from(args[args.indexOf('--title') + 1]).slice(0, 80).join('');
    if (args.includes('--clear-title')) delete own.title;
    save();
  }
  // Native report-metadata succeeds without a JSON reply.
}
else if (key === 'pane layout') ok({ layout: state.layouts?.[args[args.indexOf('--pane') + 1]] ?? state.layout });
else if (key === 'pane split') { state.lastCwd = args[args.indexOf('--cwd') + 1]; save(); ok({ pane: { pane_id: 'w1:p9' } }); }
else if (key === 'tab create') { state.lastCwd = args[args.indexOf('--cwd') + 1]; save(); ok({ root_pane: { pane_id: 'w1:p8' } }); }
else if (key === 'agent start') {
  if (state.checkRecord) {
    const entries = readFileSync(state.checkRecord, 'utf8').trim().split('\n').map(JSON.parse);
    if (!entries.some(e => e.type === 'custom' && e.customType === 'swarm_spawn' && e.data.name === args[2] && e.data.session === args[args.indexOf('--session') + 1])) fail('not_recorded', 'startup preceded spawn record');
  }
  if (state.startError) fail(state.startError, 'start failed');
  const i = args.indexOf('--session');
  state.agents.push({ name: args[2], pane_id: args[args.indexOf('--pane') + 1], agent: 'pi', cwd: state.lastCwd || dir, agent_status: 'idle', agent_session: { kind: 'path', value: i >= 0 ? args[i + 1] : '/tmp/test-session.jsonl' } });
  save(); ok({});
} else if (key === 'agent prompt') {
  const finish = () => {
    if (state.promptError || args[2] === 'blocked') fail(state.promptError || 'agent_blocked', 'prompt failed');
    if (!state.agents.some(a => a.name === args[2])) fail('agent_not_found', 'not online');
    ok({ type: 'agent_prompted' });
  };
  if (state.delay) setTimeout(finish, state.delay); else finish();
} else if (key === 'pane read') console.log('Startup diagnostics');
else ok({});
