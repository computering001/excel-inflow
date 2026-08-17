#!/usr/bin/env python3
"""Stdlib-only user-visible runtime trace helper."""
from __future__ import annotations
import hashlib, json, time, uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

WARNING_MS=30_000
INVESTIGATION_MS=120_000
BLOCK_MS=300_000
INITIAL_TARGET=0.95
ENGINEERING_TARGET=0.98

@dataclass
class ExperienceTrace:
    run_id: str
    scope: str='controller_process'
    trace_id: str=field(default_factory=lambda: uuid.uuid4().hex)
    _start_wall: float=field(default_factory=time.time)
    _start_mono: float=field(default_factory=time.monotonic)
    spans: list[dict[str, Any]]=field(default_factory=list)

    @contextmanager
    def span(self, operation: str, component: str, category: str='excel_inflow_active', *, external_wait_reason: str|None=None, metadata: dict[str, Any]|None=None):
        start=(time.monotonic()-self._start_mono)*1000
        span_id=f's{len(self.spans)+1:04d}'
        status='PASS'
        try:
            yield span_id
        except Exception:
            status='FAIL'; raise
        finally:
            end=(time.monotonic()-self._start_mono)*1000
            self.spans.append({'span_id':span_id,'parent_span_id':None,'operation':operation,'component':component,'category':category,'external_wait_reason':external_wait_reason,'start_offset_ms':start,'end_offset_ms':end,'duration_ms':max(0,end-start),'status':status,'metadata':metadata or {}})

    def finish(self)->dict[str, Any]:
        duration=max(0,(time.monotonic()-self._start_mono)*1000)
        # Coverage is interval-union based. Known external wait counts as classified.
        intervals=sorted((max(0,float(s['start_offset_ms'])),min(duration,float(s['end_offset_ms'])),s['category']) for s in self.spans)
        classified=[]
        for a,b,c in intervals:
            if c!='unknown' and b>a: classified.append((a,b))
        merged=[]
        for a,b in classified:
            if not merged or a>merged[-1][1]: merged.append([a,b])
            else: merged[-1][1]=max(merged[-1][1],b)
        classified_ms=sum(b-a for a,b in merged)
        unknown=[]; cursor=0.0
        for a,b in merged:
            if a>cursor: unknown.append((cursor,a))
            cursor=max(cursor,b)
        if cursor<duration: unknown.append((cursor,duration))
        unknown_ms=sum(b-a for a,b in unknown)
        longest=max([b-a for a,b in unknown] or [0.0])
        summary={'classified_duration_ms':classified_ms,'unknown_duration_ms':unknown_ms,'classification_ratio':1.0 if duration<=1e-9 else min(1.0,classified_ms/duration),'longest_unknown_gap_ms':longest,'warning_gap_count':sum((b-a)>WARNING_MS for a,b in unknown),'investigation_gap_count':sum((b-a)>INVESTIGATION_MS for a,b in unknown),'certification_block_gap_count':sum((b-a)>BLOCK_MS for a,b in unknown),'initial_classification_target':INITIAL_TARGET,'engineering_classification_target':ENGINEERING_TARGET}
        ended=time.time()
        return {'schema_version':'experience-trace/1.0','trace_id':self.trace_id,'run_id':self.run_id,'scope':self.scope,'started_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(self._start_wall)),'ended_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(ended)),'duration_ms':duration,'spans':self.spans,'summary':summary}

def write_trace(path: str|Path, trace: dict[str, Any])->None:
    target=Path(path); target.parent.mkdir(parents=True,exist_ok=True); target.write_text(json.dumps(trace,indent=2,sort_keys=True)+'\n','utf-8')

def trace_sha256(trace: dict[str, Any])->str:
    return hashlib.sha256((json.dumps(trace,sort_keys=True,separators=(',',':'))+'\n').encode()).hexdigest()
