// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"strconv"
	"strings"
)

type fileCoverage string

const (
	coverageRead        fileCoverage = "read"
	coverageUnreadable  fileCoverage = "unreadable"
	coverageUnsupported fileCoverage = "unsupported"
)

type fileReader func([]byte) ([]string, fileCoverage)

var fileReaders = map[fileKind]fileReader{
	kindText: readText,
	kindDOCX: readOffice,
	kindXLSX: readOffice,
	kindPPTX: readOffice,
}

const (
	officeMaxEntries  = 4096
	officeMaxInflated = 16 << 20
)

var officeBreaks = map[string]string{"p": "\n", "br": "\n", "tr": "\n", "row": "\n", "si": "\n", "tab": "\t", "tc": "\t", "c": "\t"}

var errOfficeTooLarge = errors.New("office file inflates past the limit")

type fileFact struct {
	Kind     fileKind     `json:"kind"`
	Carrier  carrierKind  `json:"carrier"`
	Bytes    int          `json:"bytes"`
	Coverage fileCoverage `json:"coverage"`
}

func (f foundFile) read() ([]TextSpan, fileFact) {
	fact := fileFact{Kind: f.Kind, Carrier: f.Carrier, Bytes: len(f.Data), Coverage: coverageUnsupported}
	spans := []TextSpan{}
	reader, ok := fileReaders[f.Kind]
	if !ok {
		return spans, fact
	}
	texts, coverage := reader(f.Data)
	fact.Coverage = coverage
	label := "file:" + strconv.Itoa(f.Index) + ":" + string(f.Kind)
	for _, text := range texts {
		spans = append(spans, TextSpan{Text: text, Label: label})
	}
	return spans, fact
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

func readText(b []byte) ([]string, fileCoverage) {
	return []string{string(b)}, coverageRead
}

func readOffice(b []byte) ([]string, fileCoverage) {
	z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil || len(z.File) > officeMaxEntries {
		return nil, coverageUnreadable
	}
	budget := int64(officeMaxInflated)
	texts := []string{}
	for _, f := range z.File {
		if !strings.HasSuffix(f.Name, ".xml") {
			continue
		}
		text, err := xmlText(f, &budget)
		if err != nil {
			return nil, coverageUnreadable
		}
		if strings.TrimSpace(text) != "" {
			texts = append(texts, text)
		}
	}
	return texts, coverageRead
}

func xmlText(f *zip.File, budget *int64) (string, error) {
	rc, err := f.Open()
	if err != nil {
		return "", err
	}
	defer func() { _ = rc.Close() }()
	limited := &io.LimitedReader{R: rc, N: *budget + 1}
	d := xml.NewDecoder(limited)
	var text strings.Builder
	for {
		token, err := d.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", err
		}
		switch t := token.(type) {
		case xml.CharData:
			text.Write(t)
		case xml.EndElement:
			text.WriteString(officeBreaks[t.Name.Local])
		}
	}
	if limited.N == 0 {
		return "", errOfficeTooLarge
	}
	*budget = limited.N - 1
	return text.String(), nil
}
