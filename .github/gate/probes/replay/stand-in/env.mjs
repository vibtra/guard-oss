if (process.env.PROBE_REPLAY_CANARY !== undefined) {
  process.stderr.write('PROBE_REPLAY_CANARY is visible\n');
  process.exit(3);
}
process.stdout.write('{"flagged":false,"findings":[]}\n');
