// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

type fileCoverage string

const (
	coverageRead        fileCoverage = "read"
	coverageUnreadable  fileCoverage = "unreadable"
	coverageUnsupported fileCoverage = "unsupported"
)

var coverageRank = map[fileCoverage]int{coverageRead: 0, coverageUnsupported: 1, coverageUnreadable: 2}

const (
	officeMaxEntries   = 4096
	requestMaxInflated = 16 << 20
	fileMaxDepth       = 2
	xlsxSharedStrings  = "xl/sharedStrings.xml"
)

var officeBreaks = map[string]string{"p": "\n", "br": "\n", "tr": "\n", "row": "\n", "si": "\n", "tab": "\t", "tc": "\t", "c": "\t"}

var errInflateBudget = errors.New("the request's files inflate past the limit")

var errSharedString = errors.New("a cell names a shared string the workbook does not have")

var errTextBudget = errors.New("the request's files hold more text than Guard reads")

type fileFact struct {
	Kind     fileKind     `json:"kind"`
	Carrier  carrierKind  `json:"carrier"`
	Bytes    int          `json:"bytes"`
	Coverage fileCoverage `json:"coverage"`
}

type fileScan struct {
	budget int64
	text   int
	files  []fileFact
}

func newFileScan() *fileScan {
	return &fileScan{budget: requestMaxInflated, text: inspectionLimit}
}

func (scan *fileScan) read(data []byte, carrier carrierKind) ([]TextSpan, fileKind) {
	kind := sniff(data)
	label := "file:" + strconv.Itoa(len(scan.files)) + ":" + string(kind)
	texts, coverage := scan.readKind(kind, data, 0)
	scan.files = append(scan.files, fileFact{Kind: kind, Carrier: carrier, Bytes: len(data), Coverage: coverage})
	spans := []TextSpan{}
	for _, text := range texts {
		if strings.TrimSpace(text) != "" {
			spans = append(spans, TextSpan{Text: text, Label: label})
		}
	}
	return spans, kind
}

func (scan *fileScan) undecodable(size int) {
	scan.files = append(scan.files, fileFact{Kind: kindUnknown, Carrier: carrierBase64, Bytes: size, Coverage: coverageUnreadable})
}

func (scan *fileScan) keep(texts ...string) ([]string, fileCoverage) {
	size := 0
	for _, text := range texts {
		size += len(text)
	}
	if size > scan.text {
		scan.text = 0
		return nil, coverageUnreadable
	}
	scan.text -= size
	return texts, coverageRead
}

func (scan *fileScan) readKind(kind fileKind, data []byte, depth int) ([]string, fileCoverage) {
	if depth > fileMaxDepth {
		return nil, coverageUnreadable
	}
	switch kind {
	case kindText:
		text, _ := fileText(data)
		return scan.keep(text)
	case kindUnknown:
		return nil, coverageUnreadable
	case kindDOCX, kindXLSX, kindPPTX:
		return scan.readOffice(kind, data, depth)
	}
	return nil, coverageUnsupported
}

func noteFiles(facts map[string]any, files []fileFact) {
	if len(files) == 0 {
		return
	}
	facts["files"] = files
	for _, f := range files {
		if f.Coverage != coverageRead {
			facts["coverageFailure"] = true
		}
	}
}

func (scan *fileScan) readOffice(kind fileKind, data []byte, depth int) ([]string, fileCoverage) {
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(z.File) > officeMaxEntries {
		return nil, coverageUnreadable
	}
	texts := []string{}
	var shared []string
	sharedAt := -1
	if kind == kindXLSX {
		sharedAt = slices.IndexFunc(z.File, func(f *zip.File) bool { return f.Name == xlsxSharedStrings })
	}
	if sharedAt >= 0 {
		b, err := scan.inflate(z.File[sharedAt])
		if err == nil {
			shared, err = sharedStrings(b)
		}
		if err != nil {
			return nil, coverageUnreadable
		}
		kept, coverage := scan.keep(strings.Join(shared, "\n"))
		if coverage != coverageRead {
			return nil, coverage
		}
		texts = append(texts, kept...)
	}
	coverage := coverageRead
	for i, f := range z.File {
		if i == sharedAt {
			continue
		}
		entryTexts, entryCoverage := scan.readEntry(kind, f, shared, depth)
		texts = append(texts, entryTexts...)
		if coverageRank[entryCoverage] > coverageRank[coverage] {
			coverage = entryCoverage
		}
	}
	return texts, coverage
}

func (scan *fileScan) readEntry(kind fileKind, f *zip.File, shared []string, depth int) ([]string, fileCoverage) {
	data, err := scan.inflate(f)
	if err != nil {
		return nil, coverageUnreadable
	}
	var texts []string
	switch {
	case kind == kindXLSX && strings.HasPrefix(f.Name, "xl/worksheets/") && strings.HasSuffix(f.Name, ".xml"):
		var grid string
		grid, err = sheetText(data, shared, scan.text)
		if err == nil {
			texts, err = xmlText(data, nil)
			texts = append(texts, grid)
		}
	case strings.HasSuffix(f.Name, ".xml") || strings.HasSuffix(f.Name, ".rels"):
		texts, err = xmlText(data, officeValues(kind, f.Name))
	default:
		entry := sniff(data)
		if entry == kindUnknown && officeBinaryPart(f.Name) {
			return nil, coverageRead
		}
		return scan.readKind(entry, data, depth+1)
	}
	if err != nil {
		return nil, coverageUnreadable
	}
	return scan.keep(texts...)
}

func officeValues(kind fileKind, name string) []string {
	if kind == kindXLSX && strings.HasPrefix(name, "xl/pivotCache/") {
		return []string{"descr", "title", "v"}
	}
	return []string{"descr", "title"}
}

func officeBinaryPart(name string) bool {
	return strings.Contains(name, "/printerSettings/") || strings.HasSuffix(name, ".odttf") || strings.HasSuffix(name, ".fntdata")
}

func (scan *fileScan) inflate(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	data, err := io.ReadAll(io.LimitReader(rc, scan.budget+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > scan.budget {
		scan.budget = 0
		return nil, errInflateBudget
	}
	scan.budget -= int64(len(data))
	return data, nil
}

func xmlText(data []byte, values []string) ([]string, error) {
	d := xml.NewDecoder(bytes.NewReader(data))
	var text, aside strings.Builder
	note := func(value string) {
		aside.WriteString(value)
		aside.WriteByte('\n')
	}
	deleted := 0
	for {
		token, err := d.Token()
		if errors.Is(err, io.EOF) {
			return []string{text.String(), aside.String()}, nil
		}
		if err != nil {
			return nil, err
		}
		switch t := token.(type) {
		case xml.StartElement:
			if officeDeleted(t.Name.Local) {
				deleted++
			}
			external := slices.ContainsFunc(t.Attr, func(a xml.Attr) bool { return a.Name.Local == "TargetMode" && a.Value == "External" })
			for _, a := range t.Attr {
				target := external && a.Name.Local == "Target"
				if target || slices.Contains(values, a.Name.Local) {
					note(a.Value)
				}
				if unescaped, err := url.QueryUnescape(a.Value); target && err == nil && unescaped != a.Value {
					note(unescaped)
				}
			}
		case xml.CharData:
			if deleted > 0 {
				aside.Write(t)
			} else {
				text.Write(t)
			}
		case xml.EndElement:
			if officeDeleted(t.Name.Local) && deleted > 0 {
				deleted--
				if deleted == 0 {
					aside.WriteByte('\n')
				}
			}
			text.WriteString(officeBreaks[t.Name.Local])
		}
	}
}

func officeDeleted(name string) bool {
	return name == "del" || name == "delText"
}

func sharedStrings(data []byte) ([]string, error) {
	d := xml.NewDecoder(bytes.NewReader(data))
	shared := []string{}
	var item strings.Builder
	inText := false
	for {
		token, err := d.Token()
		if errors.Is(err, io.EOF) {
			return shared, nil
		}
		if err != nil {
			return nil, err
		}
		switch t := token.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				item.Reset()
			case "t":
				inText = true
			}
		case xml.CharData:
			if inText {
				item.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inText = false
			case "si":
				shared = append(shared, item.String())
			}
		}
	}
}

func sheetText(data []byte, shared []string, limit int) (string, error) {
	d := xml.NewDecoder(bytes.NewReader(data))
	var rows, cells []string
	var cell strings.Builder
	cellType := ""
	inValue := false
	size := 0
	for {
		token, err := d.Token()
		if errors.Is(err, io.EOF) {
			return strings.Join(rows, "\n"), nil
		}
		if err != nil {
			return "", err
		}
		switch t := token.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "c":
				cell.Reset()
				cellType = ""
				for _, a := range t.Attr {
					if a.Name.Local == "t" {
						cellType = a.Value
					}
				}
			case "v", "t":
				inValue = true
			}
		case xml.CharData:
			if inValue {
				cell.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v", "t":
				inValue = false
			case "c":
				value := cell.String()
				if cellType == "s" {
					i, err := strconv.Atoi(strings.TrimSpace(value))
					if err != nil || i < 0 || i >= len(shared) {
						return "", errSharedString
					}
					value = shared[i]
				}
				size += len(value) + 1
				if size > limit {
					return "", errTextBudget
				}
				cells = append(cells, value)
			case "row":
				rows = append(rows, strings.Join(cells, "\t"))
				cells = cells[:0]
			}
		}
	}
}
