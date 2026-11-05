package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"reflect"
)

type request struct {
	Name   string `json:"name"`
	Source string `json:"source"`
}

type response struct {
	Printed string `json:"printed"`
	Error   string `json:"error,omitempty"`
}

var posType = reflect.TypeOf(token.NoPos)

func main() {
	transform := normalize
	if len(os.Args) > 1 && os.Args[1] == "format" {
		transform = gofmt
	}
	var requests []request
	if err := json.NewDecoder(os.Stdin).Decode(&requests); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	responses := make([]response, len(requests))
	for i, r := range requests {
		responses[i] = transform(r)
	}
	if err := json.NewEncoder(os.Stdout).Encode(responses); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}

func gofmt(r request) response {
	out, err := format.Source([]byte(r.Source))
	if err != nil {
		return response{Error: err.Error()}
	}
	return response{Printed: string(out)}
}

func normalize(r request) response {
	file, err := parser.ParseFile(token.NewFileSet(), r.Name, r.Source, parser.SkipObjectResolution)
	if err != nil {
		return response{Error: err.Error()}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		if n != nil {
			clearPositions(reflect.ValueOf(n))
		}
		return true
	})
	var out bytes.Buffer
	config := printer.Config{Mode: printer.UseSpaces | printer.TabIndent, Tabwidth: 8}
	if err := config.Fprint(&out, token.NewFileSet(), file); err != nil {
		return response{Error: err.Error()}
	}
	return response{Printed: out.String()}
}

func clearPositions(v reflect.Value) {
	if v.Kind() != reflect.Pointer || v.IsNil() || v.Elem().Kind() != reflect.Struct {
		return
	}
	v = v.Elem()
	for i := range v.NumField() {
		if field := v.Field(i); field.Type() == posType && field.CanSet() {
			field.SetInt(int64(token.NoPos))
		}
	}
}
