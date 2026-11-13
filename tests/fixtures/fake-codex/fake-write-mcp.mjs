#!/usr/bin/env node
// A stand-in for a write-capable MCP server that a user's codex config might list. Not a real MCP server:
// the fake codex starts it like codex starts the configured servers (it records that it was started), and runs it
// again with --call when a prompt asks the model to use it (it records that it was called). A test that finds the
// marker file empty knows the judge neither loaded nor called the server.
import { appendFileSync } from 'node:fs';

const marker = process.env.FAKE_MCP_MARKER;
if (marker) appendFileSync(marker, process.argv.includes('--call') ? 'called\n' : 'started\n');
