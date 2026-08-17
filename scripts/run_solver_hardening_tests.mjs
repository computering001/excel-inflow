#!/usr/bin/env node
import assert from 'node:assert/strict'; import {detectTwoCycle} from './lib/solver.mjs'; assert.equal(detectTwoCycle([1,2],[2,3],[1,2],1e-8),true); assert.equal(detectTwoCycle([1,2],[1,2],[1,2],1e-8),false); assert.equal(detectTwoCycle(null,[2],[1],1e-8),false); console.log(JSON.stringify({status:'PASS',checks:3}));
