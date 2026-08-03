#!/usr/bin/env node
import { runFixtureCli } from "../src/paper-fixture/fixture-cli.mjs";

process.exitCode = await runFixtureCli();
