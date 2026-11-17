package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const minReason = 20

const advice = "an http.Client with no Transport uses http.DefaultTransport, which trusts every root in the system store, including user-added ones (the #44 bug). " +
	"Set Transport to one with explicit roots, as registryClient in guard/agent-go/registry_origin.go does, or list the file in tools/go-guardrails/http-client-allow.json with a reason."

type allowEntry struct {
	File   string `json:"file"`
	Reason string `json:"reason"`
}

type allowList struct {
	Allow []allowEntry `json:"allow"`
}

type finding struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Form string `json:"form"`
	Fix  string `json:"fix"`
}

func main() {
	if len(os.Args) < 4 {
		fmt.Fprintln(os.Stderr, "usage: go run -C tools/go-guardrails . <allow.json> <repo root> <dir>...")
		os.Exit(2)
	}
	allowed, problems := readAllowList(os.Args[1])
	if len(problems) > 0 {
		for _, p := range problems {
			fmt.Fprintln(os.Stderr, p)
		}
		os.Exit(2)
	}
	base := os.Args[2]
	findings := []finding{}
	for _, root := range os.Args[3:] {
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".go") {
				return nil
			}
			rel, err := filepath.Rel(base, path)
			if err != nil {
				return err
			}
			file := filepath.ToSlash(rel)
			if _, ok := allowed[file]; ok {
				return nil
			}
			found, err := check(path)
			if err != nil {
				return err
			}
			for _, f := range found {
				findings = append(findings, finding{File: file, Line: f.line, Form: f.form, Fix: advice})
			}
			return nil
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
	}
	sort.Slice(findings, func(i, j int) bool {
		if findings[i].File != findings[j].File {
			return findings[i].File < findings[j].File
		}
		return findings[i].Line < findings[j].Line
	})
	out, _ := json.Marshal(map[string]any{"findings": findings})
	fmt.Println(string(out))
	if len(findings) > 0 {
		os.Exit(1)
	}
}

func readAllowList(path string) (map[string]string, []string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, []string{err.Error()}
	}
	var list allowList
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, []string{fmt.Sprintf("%s: %v", path, err)}
	}
	allowed := map[string]string{}
	var problems []string
	for _, entry := range list.Allow {
		if len(strings.TrimSpace(entry.Reason)) < minReason {
			problems = append(problems, fmt.Sprintf("%s: the entry for %q needs a reason of at least %d characters that says why this client may use the system roots", path, entry.File, minReason))
			continue
		}
		allowed[entry.File] = entry.Reason
	}
	return allowed, problems
}

type hit struct {
	line int
	form string
}

func check(path string) ([]hit, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		return nil, err
	}
	httpName := ""
	for _, spec := range file.Imports {
		if p, _ := strconv.Unquote(spec.Path.Value); p == "net/http" {
			httpName = "http"
			if spec.Name != nil {
				httpName = spec.Name.Name
			}
		}
	}
	if httpName == "" || httpName == "_" {
		return nil, nil
	}
	isClient := func(expr ast.Expr) bool {
		if star, ok := expr.(*ast.StarExpr); ok {
			expr = star.X
		}
		if httpName == "." {
			ident, ok := expr.(*ast.Ident)
			return ok && ident.Name == "Client"
		}
		sel, ok := expr.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "Client" {
			return false
		}
		pkg, ok := sel.X.(*ast.Ident)
		return ok && pkg.Name == httpName
	}
	var hits []hit
	add := func(node ast.Node, form string) {
		hits = append(hits, hit{line: fset.Position(node.Pos()).Line, form: form})
	}
	ast.Inspect(file, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.CompositeLit:
			if n.Type == nil || !isClient(n.Type) {
				return true
			}
			for _, elt := range n.Elts {
				kv, ok := elt.(*ast.KeyValueExpr)
				if !ok {
					return true
				}
				if key, ok := kv.Key.(*ast.Ident); ok && key.Name == "Transport" {
					return true
				}
			}
			add(n, "http.Client{} without Transport")
		case *ast.CallExpr:
			if fn, ok := n.Fun.(*ast.Ident); ok && fn.Name == "new" && len(n.Args) == 1 && isClient(n.Args[0]) {
				add(n, "new(http.Client)")
			}
		case *ast.ValueSpec:
			if n.Type != nil && len(n.Values) == 0 {
				if _, pointer := n.Type.(*ast.StarExpr); !pointer && isClient(n.Type) {
					add(n, "var of type http.Client")
				}
			}
		}
		return true
	})
	return hits, nil
}
