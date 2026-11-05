// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package detect

import (
	"regexp"
	"strconv"
	"strings"
)

var dateShaped = regexp.MustCompile(`^(?:[0-9]{1,4}[-./ ][0-9]{1,2}[-./ ][0-9]{1,4})$`)

var checks = map[string]func(string) bool{
	"us-ssn":          validSSN,
	"us-itin":         validITIN,
	"us-routing":      validRouting,
	"us-routing-pair": validRoutingPair,
	"us-npi":          validNPI,
	"au-ihi":          validIHI,
	"iban":            validIBAN,
	"luhn":            func(s string) bool { d := digits(s); return len(d) >= 12 && len(d) <= 19 && luhnValid(d) },
	"licence":         validLicence,
	"digits3":         minDigits(3),
	"digits4":         minDigits(4),
	"digits5":         minDigits(5),
	"digits6":         minDigits(6),
	"id-shape":        idShaped,
}

func idShaped(s string) bool {
	if len(digits(s)) < 5 {
		return false
	}
	return !dateShaped.MatchString(s)
}

func minDigits(n int) func(string) bool {
	return func(s string) bool { return len(digits(s)) >= n }
}

func luhnValid(s string) bool {
	total := 0
	for i := range len(s) {
		d := int(s[len(s)-1-i] - '0')
		if i%2 == 1 {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		total += d
	}
	return total%10 == 0
}

func validSSN(s string) bool {
	d := digits(s)
	return len(d) == 9 && d[:3] != "000" && d[:3] != "666" && d[0] != '9' && d[3:5] != "00" && d[5:] != "0000"
}

func validITIN(s string) bool {
	d := digits(s)
	if len(d) != 9 || d[0] != '9' {
		return false
	}
	g, _ := strconv.Atoi(d[3:5])
	return g >= 50 && g <= 65 || g >= 70 && g <= 88 || g >= 90 && g <= 92 || g >= 94 && g <= 99
}

func validRouting(s string) bool {
	d := digits(s)
	if len(d) != 9 {
		return false
	}
	return sumWeights(d, []int{3, 7, 1, 3, 7, 1, 3, 7, 1})%10 == 0
}

func validRoutingPair(s string) bool {
	d := digits(s)
	return len(d) > 9 && validRouting(d[:9])
}

func validNPI(s string) bool {
	d := digits(s)
	return len(d) == 10 && (d[0] == '1' || d[0] == '2') && luhnValid("80840"+d)
}

func validIHI(s string) bool {
	d := digits(s)
	return len(d) == 16 && strings.HasPrefix(d, "800360") && luhnValid(d)
}

func validLicence(s string) bool {
	return digits(s) != "" && (!strings.Contains(s, "-") || strings.ContainsAny(s, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"))
}

func validIBAN(s string) bool {
	b := []byte{}
	for i := range len(s) {
		c := s[i]
		if c == ' ' || c == '-' {
			continue
		}
		b = append(b, c)
	}
	if len(b) < 15 || len(b) > 34 {
		return false
	}
	rem := 0
	for _, c := range append(append([]byte{}, b[4:]...), b[:4]...) {
		switch {
		case c >= '0' && c <= '9':
			rem = (rem*10 + int(c-'0')) % 97
		case c >= 'A' && c <= 'Z':
			rem = (rem*100 + int(c-'A') + 10) % 97
		default:
			return false
		}
	}
	return rem == 1
}
