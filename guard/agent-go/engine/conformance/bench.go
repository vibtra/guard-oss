// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package conformance

import (
	"context"
	"testing"

	"github.com/vibtra/guard/guard/agent-go/engine"
)

type BenchResult struct {
	Set         string
	Cases       int
	NsPerOp     int64
	NsPerCase   int64
	AllocsPerOp int64
	Errors      []Failure
}

func Bench(e engine.Engine, opts ...Option) []BenchResult {
	c := configure(opts)
	probes := invariantProbes()
	sets := []vectorSet{{name: "invariants", cases: make([]vectorCase, len(probes))}}
	for i, p := range probes {
		sets[0].cases[i] = vectorCase{name: p.name, req: p.req}
	}
	if c.vectors != nil {
		sets = append(sets, c.vectors.sets...)
	}
	ctx := context.Background()
	out := make([]BenchResult, 0, len(sets))
	for _, s := range sets {
		res := BenchResult{Set: s.name, Cases: len(s.cases)}
		for _, vc := range s.cases {
			if _, err := decide(e, vc.req); err != nil {
				res.Errors = append(res.Errors, Failure{vc.name, err.Error()})
			}
		}
		if len(res.Errors) == 0 && len(s.cases) > 0 {
			r := testing.Benchmark(func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					for _, vc := range s.cases {
						_, _ = e.Decide(ctx, vc.req)
					}
				}
			})
			res.NsPerOp = r.NsPerOp()
			res.NsPerCase = res.NsPerOp / int64(len(s.cases))
			res.AllocsPerOp = r.AllocsPerOp()
		}
		out = append(out, res)
	}
	return out
}
