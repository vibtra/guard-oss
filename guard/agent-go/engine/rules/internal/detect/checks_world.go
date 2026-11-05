// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package detect

import (
	"strconv"
	"strings"
	"time"
)

func init() {
	for name, fn := range map[string]func(string) bool{
		"w-luhn":        wLuhnAny,
		"w-verhoeff":    func(s string) bool { d := digits(s); return !wRep(d) && wVerhoeff(d) },
		"gb-nino":       wNino,
		"gb-dl":         wGBDL,
		"gb-nhs":        wNHS,
		"gb-chi":        wCHI,
		"gb-hc":         wHC,
		"gb-utr":        wUTR,
		"ie-pps":        wPPS,
		"ca-sin":        wSIN,
		"ca-bc-phn":     wBCPHN,
		"nz-ird":        wIRD,
		"nz-nhi":        wNHI,
		"br-cpf":        wCPF,
		"br-cns":        wCNS,
		"br-cnh":        wCNH,
		"br-titulo":     wTitulo,
		"br-pis":        wPIS,
		"in-aadhaar":    wAadhaar,
		"in-vid":        wVID,
		"in-pan":        wPAN,
		"sg-nric":       wNRIC,
		"hk-id":         wHKID,
		"tw-id":         wTWID,
		"cn-ric":        wCNRIC,
		"kr-rrn":        wRRN,
		"kr-frn":        wFRN,
		"kr-dl":         wKRDL,
		"jp-my-number":  wMyNumber,
		"th-pin":        wThaiPIN,
		"id-nik":        wNIK,
		"id-npwp":       wNPWP,
		"ph-tin":        wPHTIN,
		"my-nric":       wMyKad,
		"pk-cnic":       wCNIC,
		"ae-eid":        wEmirates,
		"sa-id":         wSaudi,
		"il-id":         wIsrael,
		"ir-nid":        wIran,
		"tr-tckn":       wTCKN,
		"za-id":         wZAID,
		"za-dl":         wZADL,
		"eg-nid":        wEgypt,
		"mx-curp":       wCURP,
		"mx-rfc":        wRFC,
		"mx-clabe":      wCLABE,
		"ar-cuil":       wCUIL,
		"ar-cbu":        wCBU,
		"cl-rut":        wRUT,
		"ec-ci":         wEcuador,
		"uy-ci":         wUruguay,
		"sv-dui":        wDUI,
		"ve-rif":        wRIF,
		"cu-ni":         wCuba,
		"de-idnr":       wIdNr,
		"de-rvnr":       wRVNR,
		"de-kvnr":       wKVNR,
		"de-doc":        wDEDoc,
		"de-lanr":       wLANR,
		"fr-nir":        wNIR,
		"fr-nif":        wFRNIF,
		"es-dni":        wDNI,
		"es-nie":        wNIE,
		"es-nuss":       wNUSS,
		"es-ccc":        wCCC,
		"it-cf":         wCF,
		"pt-nif":        wPTNIF,
		"pt-cc":         wPTCC,
		"nl-bsn":        wBSN,
		"be-nn":         wBENN,
		"be-eid":        wBEEID,
		"lu-matricule":  wLUMat,
		"ch-ahv":        wAHV,
		"at-svnr":       wATSV,
		"se-pnr":        wSEPnr,
		"no-fnr":        wNOFnr,
		"no-konto":      wNOKonto,
		"dk-cpr":        wDKCPR,
		"fi-hetu":       wHetu,
		"is-kt":         wKennitala,
		"pl-pesel":      wPESEL,
		"pl-nip":        wNIP,
		"pl-id":         wPLID,
		"cz-rc":         wCZRC,
		"hu-taj":        wTAJ,
		"hu-tax":        wHUTax,
		"ro-cnp":        wCNP,
		"bg-egn":        wEGN,
		"hr-oib":        wOIB,
		"w-jmbg":        wJMBG,
		"si-tax":        wSITax,
		"gr-amka":       wAMKA,
		"gr-afm":        wAFM,
		"cy-tic":        wCYTIC,
		"ee-ik":         wEEIK,
		"lv-pk":         wLVPK,
		"ua-rntrc":      wUARNTRC,
		"ru-inn":        wRUINN,
		"ru-snils":      wSNILS,
		"kz-iin":        wKZIIN,
		"us-dea":        wDEA,
		"co-nit":        wCONIT,
		"nl-onderwijs":  wOnderwijs,
		"w-has-letter":  wHasLetter,
		"w-not-repeats": func(s string) bool { return !wRep(digits(s)) },
	} {
		checks[name] = fn
	}
}

func wUpper(s string) string {
	b := make([]byte, 0, len(s))
	for i := range len(s) {
		c := s[i]
		switch {
		case c >= '0' && c <= '9', c >= 'A' && c <= 'Z':
			b = append(b, c)
		case c >= 'a' && c <= 'z':
			b = append(b, c-'a'+'A')
		}
	}
	return string(b)
}

func wRep(d string) bool {
	if d == "" {
		return true
	}
	return strings.Count(d, d[:1]) == len(d)
}

func wAtoi(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return -1
	}
	return n
}

func wDate(y, m, d int) bool {
	if y < 0 || y > time.Now().Year() || m < 1 || m > 12 || d < 1 {
		return false
	}
	days := [...]int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	limit := days[m-1]
	if m == 2 && (y%4 == 0 && y%100 != 0 || y%400 == 0) {
		limit = 29
	}
	return d <= limit
}

func wAnyCentury(yy, m, d int) bool {
	return wDate(1900+yy, m, d) || wDate(2000+yy, m, d)
}

func wLuhn(d string) bool {
	total := 0
	for i := range len(d) {
		n := int(d[len(d)-1-i] - '0')
		if i%2 == 1 {
			n *= 2
			if n > 9 {
				n -= 9
			}
		}
		total += n
	}
	return total%10 == 0
}

func wLuhnAny(s string) bool {
	d := digits(s)
	return !wRep(d) && wLuhn(d)
}

func wWeighted(d string, weights ...int) int {
	return sumWeights(d, weights)
}

var wVerD = [10][10]int{
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9},
	{1, 2, 3, 4, 0, 6, 7, 8, 9, 5},
	{2, 3, 4, 0, 1, 7, 8, 9, 5, 6},
	{3, 4, 0, 1, 2, 8, 9, 5, 6, 7},
	{4, 0, 1, 2, 3, 9, 5, 6, 7, 8},
	{5, 9, 8, 7, 6, 0, 4, 3, 2, 1},
	{6, 5, 9, 8, 7, 1, 0, 4, 3, 2},
	{7, 6, 5, 9, 8, 2, 1, 0, 4, 3},
	{8, 7, 6, 5, 9, 3, 2, 1, 0, 4},
	{9, 8, 7, 6, 5, 4, 3, 2, 1, 0},
}

var wVerP = [8][10]int{
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9},
	{1, 5, 7, 6, 2, 8, 3, 0, 9, 4},
	{5, 8, 0, 3, 7, 9, 6, 1, 4, 2},
	{8, 9, 1, 6, 0, 4, 3, 5, 2, 7},
	{9, 4, 5, 3, 1, 2, 6, 8, 7, 0},
	{4, 2, 8, 6, 5, 7, 3, 9, 0, 1},
	{2, 7, 9, 3, 8, 0, 6, 4, 1, 5},
	{7, 0, 4, 6, 9, 1, 3, 2, 5, 8},
}

func wVerhoeff(d string) bool {
	c := 0
	for i := range len(d) {
		c = wVerD[c][wVerP[i%8][int(d[len(d)-1-i]-'0')]]
	}
	return c == 0
}

func wIso7064(d string) bool {
	p := 10
	for i := range len(d) - 1 {
		t := (int(d[i]-'0') + p) % 10
		if t == 0 {
			t = 10
		}
		p = t * 2 % 11
	}
	c := 11 - p
	if c == 10 {
		c = 0
	}
	return c == int(d[len(d)-1]-'0')
}

func wNino(s string) bool {
	u := wUpper(s)
	if len(u) != 8 && len(u) != 9 {
		return false
	}
	switch u[:2] {
	case "BG", "GB", "NK", "KN", "NT", "TN", "ZZ":
		return false
	}
	return u[2:8] != "000000"
}

func wGBDL(s string) bool {
	u := wUpper(s)
	if len(u) != 16 || u[:5] == "99999" {
		return false
	}
	nine := false
	for i := range 5 {
		if u[i] == '9' {
			nine = true
		} else if nine {
			return false
		}
	}
	return u[0] != '9'
}

func wNHS(s string) bool {
	d := digits(s)
	if len(d) != 10 || wRep(d) {
		return false
	}
	return wWeighted(d, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1)%11 == 0
}

func wCHI(s string) bool {
	d := digits(s)
	return wNHS(d) && wAnyCentury(wAtoi(d[4:6]), wAtoi(d[2:4]), wAtoi(d[:2]))
}

func wHC(s string) bool {
	d := digits(s)
	if !wNHS(d) {
		return false
	}
	p := wAtoi(d[:3])
	return p >= 320 && p <= 399
}

func wUTR(s string) bool {
	d := digits(s)
	if len(d) != 10 || wRep(d) {
		return false
	}
	n := wWeighted(d[1:], 6, 7, 8, 9, 10, 5, 4, 3, 2)
	return "21987654321"[n%11] == d[0]
}

func wPPS(s string) bool {
	u := wUpper(s)
	if len(u) != 8 && len(u) != 9 {
		return false
	}
	if wRep(u[:7]) {
		return false
	}
	n := wWeighted(u[:7], 8, 7, 6, 5, 4, 3, 2)
	if len(u) == 9 && u[8] != 'W' {
		n += int(u[8]-'A'+1) * 9
	}
	n %= 23
	want := byte('W')
	if n != 0 {
		want = byte('A' + n - 1)
	}
	return u[7] == want
}

func wSIN(s string) bool {
	d := digits(s)
	return len(d) == 9 && d[0] != '0' && d[0] != '8' && !wRep(d) && wLuhn(d)
}

func wBCPHN(s string) bool {
	d := digits(s)
	if len(d) != 10 || d[0] != '9' {
		return false
	}
	n := wWeighted(d[1:], 2, 4, 8, 5, 10, 9, 7, 3)
	return (11-n%11)%11 == int(d[9]-'0')
}

func wIRD(s string) bool {
	d := digits(s)
	if len(d) != 8 && len(d) != 9 {
		return false
	}
	n := wAtoi(d)
	if n <= 10000000 || n >= 150000000 {
		return false
	}
	if len(d) == 8 {
		d = "0" + d
	}
	c := wWeighted(d, 3, 2, 7, 6, 5, 4, 3, 2) % 11
	if c != 0 {
		c = 11 - c
	}
	if c == 10 {
		c = wWeighted(d, 7, 4, 3, 2, 5, 2, 7, 6) % 11
		if c != 0 {
			c = 11 - c
		}
		if c == 10 {
			return false
		}
	}
	return c == int(d[8]-'0')
}

func wNHIValue(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'A' && c <= 'H':
		return int(c-'A') + 1
	case c >= 'J' && c <= 'N':
		return int(c-'J') + 9
	case c >= 'P' && c <= 'Z':
		return int(c-'P') + 14
	}
	return -1
}

func wNHI(s string) bool {
	u := wUpper(s)
	if len(u) != 7 {
		return false
	}
	n := 0
	for i := range 6 {
		v := wNHIValue(u[i])
		if v < 0 {
			return false
		}
		n += v * (7 - i)
	}
	if digit(u[5]) {
		r := n % 11
		if r == 0 {
			return false
		}
		c := 11 - r
		if c == 10 {
			c = 0
		}
		return digit(u[6]) && int(u[6]-'0') == c
	}
	return !digit(u[6]) && wNHIValue(u[6]) == 23-n%23
}

func wCPF(s string) bool {
	d := digits(s)
	if len(d) != 11 || wRep(d) {
		return false
	}
	a := wWeighted(d, 10, 9, 8, 7, 6, 5, 4, 3, 2) * 10 % 11 % 10
	b := wWeighted(d, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2) * 10 % 11 % 10
	return a == int(d[9]-'0') && b == int(d[10]-'0')
}

func wCNS(s string) bool {
	d := digits(s)
	if len(d) != 15 || !strings.ContainsAny(d[:1], "12789") {
		return false
	}
	return wWeighted(d, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1)%11 == 0
}

func wCNH(s string) bool {
	d := digits(s)
	if len(d) != 11 || wRep(d) {
		return false
	}
	a := wWeighted(d, 9, 8, 7, 6, 5, 4, 3, 2, 1) % 11
	off := 0
	if a >= 10 {
		a, off = 0, 2
	}
	b := wWeighted(d, 1, 2, 3, 4, 5, 6, 7, 8, 9) % 11
	if b >= 10 {
		b = 0
	} else {
		b -= off
		if b < 0 {
			b += 11
		}
	}
	return a == int(d[9]-'0') && b == int(d[10]-'0')
}

func wTitulo(s string) bool {
	d := digits(s)
	if len(d) != 12 || wRep(d) {
		return false
	}
	uf := wAtoi(d[8:10])
	if uf < 1 || uf > 28 {
		return false
	}
	a := wWeighted(d, 2, 3, 4, 5, 6, 7, 8, 9) % 11
	if a == 0 && uf <= 2 {
		a = 1
	}
	if a == 10 {
		a = 0
	}
	b := (int(d[8]-'0')*7 + int(d[9]-'0')*8 + a*9) % 11
	if b == 0 && uf <= 2 {
		b = 1
	}
	if b == 10 {
		b = 0
	}
	return a == int(d[10]-'0') && b == int(d[11]-'0')
}

func wPIS(s string) bool {
	d := digits(s)
	if len(d) != 11 || wRep(d) {
		return false
	}
	c := 11 - wWeighted(d, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)%11
	if c >= 10 {
		c = 0
	}
	return c == int(d[10]-'0')
}

func wAadhaar(s string) bool {
	d := digits(s)
	if len(d) != 12 || d[0] < '2' || !wVerhoeff(d) {
		return false
	}
	for i := range 6 {
		if d[i] != d[11-i] {
			return true
		}
	}
	return false
}

func wVID(s string) bool {
	d := digits(s)
	return len(d) == 16 && d[0] >= '2' && !wRep(d) && wVerhoeff(d)
}

func wPAN(s string) bool {
	u := wUpper(s)
	return len(u) == 10 && strings.IndexByte("ABCFGHJLPT", u[3]) >= 0 && u[5:9] != "0000"
}

func wNRIC(s string) bool {
	u := wUpper(s)
	if len(u) != 9 {
		return false
	}
	n := wWeighted(u[1:8], 2, 7, 6, 5, 4, 3, 2)
	switch u[0] {
	case 'S':
		return "JZIHGFEDCBA"[n%11] == u[8]
	case 'T':
		return "JZIHGFEDCBA"[(n+4)%11] == u[8]
	case 'F':
		return "XWUTRQPNMLK"[n%11] == u[8]
	case 'G':
		return "XWUTRQPNMLK"[(n+4)%11] == u[8]
	case 'M':
		return "XWUTRQPNJLK"[(n+3)%11] == u[8]
	}
	return false
}

func wHKID(s string) bool {
	u := wUpper(s)
	if len(u) != 8 && len(u) != 9 {
		return false
	}
	if len(u) == 8 {
		u = "3" + u
	}
	n := 0
	for i := range 8 {
		c := u[i]
		v := int(c - '0')
		if c >= 'A' && c <= 'Z' {
			v = int(c-'A'+10) % 11
		}
		n += v * (9 - i)
	}
	n %= 11
	want := byte('0')
	switch n {
	case 0:
	case 1:
		want = 'A'
	default:
		want = byte('0' + 11 - n)
	}
	return u[8] == want
}

func wTWID(s string) bool {
	u := wUpper(s)
	if len(u) < 10 {
		return false
	}
	u = u[len(u)-10:]
	if u[0] < 'A' || u[0] > 'Z' || strings.IndexByte("1289", u[1]) < 0 {
		return false
	}
	code := [...]int{10, 11, 12, 13, 14, 15, 16, 17, 34, 18, 19, 20, 21, 22, 35, 23, 24, 25, 26, 27, 28, 29, 32, 30, 31, 33}[u[0]-'A']
	n := code%10*9 + code/10 + wWeighted(u[1:], 8, 7, 6, 5, 4, 3, 2, 1, 1)
	return n%10 == 0
}

const wCNProvinces = "11 12 13 14 15 21 22 23 31 32 33 34 35 36 37 41 42 43 44 45 46 50 51 52 53 54 61 62 63 64 65 71 81 82 91"

func wCNRIC(s string) bool {
	u := wUpper(s)
	start := 0
	for start < len(u) && !digit(u[start]) {
		start++
	}
	u = u[start:]
	switch len(u) {
	case 15:
		if !strings.Contains(wCNProvinces, u[:2]) || digits(u) != u {
			return false
		}
		return wDate(1900+wAtoi(u[6:8]), wAtoi(u[8:10]), wAtoi(u[10:12]))
	case 18:
		if !strings.Contains(wCNProvinces, u[:2]) || digits(u[:17]) != u[:17] {
			return false
		}
		y := wAtoi(u[6:10])
		if y < 1900 || y > 2099 || !wDate(y, wAtoi(u[10:12]), wAtoi(u[12:14])) {
			return false
		}
		n := wWeighted(u, 7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
		return "10X98765432"[n%11] == u[17]
	}
	return false
}

func wRRNDate(d string) bool {
	century := 1900
	switch d[6] {
	case '3', '4', '7', '8':
		century = 2000
	case '9', '0':
		century = 1800
	}
	return wDate(century+wAtoi(d[:2]), wAtoi(d[2:4]), wAtoi(d[4:6]))
}

func wRRN(s string) bool {
	d := digits(s)
	if len(d) != 13 || !wRRNDate(d) || wAtoi(d[7:9]) > 95 {
		return false
	}
	n := wWeighted(d, 2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5)
	return (11-n%11)%10 == int(d[12]-'0')
}

func wFRN(s string) bool {
	d := digits(s)
	if len(d) != 13 || !wRRNDate(d) {
		return false
	}
	n := wWeighted(d, 2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5)
	return (13-n%11)%10 == int(d[12]-'0')
}

func wKRDL(s string) bool {
	d := digits(s)
	if len(d) != 12 {
		return false
	}
	r := wAtoi(d[:2])
	return r >= 11 && r <= 28 && r != 27
}

func wMyNumber(s string) bool {
	d := digits(s)
	if len(d) != 12 || wRep(d) {
		return false
	}
	r := wWeighted(d, 6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2) % 11
	c := 0
	if r > 1 {
		c = 11 - r
	}
	return c == int(d[11]-'0')
}

func wThaiPIN(s string) bool {
	d := digits(s)
	if len(d) != 13 || d[0] == '0' || d[0] == '9' {
		return false
	}
	n := wWeighted(d, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2)
	return (11-n%11)%10 == int(d[12]-'0')
}

func wNIK(s string) bool {
	d := digits(s)
	if len(d) != 16 || d[:6] == "000000" || d[12:] == "0000" {
		return false
	}
	day := wAtoi(d[6:8])
	if day > 40 {
		day -= 40
	}
	return wAnyCentury(wAtoi(d[10:12]), wAtoi(d[8:10]), day)
}

func wNPWP(s string) bool {
	d := digits(s)
	return len(d) == 15 && !wRep(d) && wLuhn(d[:9])
}

func wPHTIN(s string) bool {
	d := digits(s)
	if len(d) != 9 && len(d) != 12 {
		return false
	}
	return !wRep(d) && wWeighted(d, 9, 8, 7, 6, 5, 4, 3, 2)%11 == int(d[8]-'0')
}

func wMyKad(s string) bool {
	d := digits(s)
	if len(d) != 12 || d[6:8] == "00" || d[8:] == "0000" {
		return false
	}
	return wAnyCentury(wAtoi(d[:2]), wAtoi(d[2:4]), wAtoi(d[4:6]))
}

func wCNIC(s string) bool {
	d := digits(s)
	return len(d) == 13 && d[0] >= '1' && d[0] <= '7' && d[12] != '0' && !wRep(d[5:12])
}

func wEmirates(s string) bool {
	d := digits(s)
	return len(d) == 15 && strings.HasPrefix(d, "784") && wLuhn(d)
}

func wSaudi(s string) bool {
	d := digits(s)
	return len(d) == 10 && (d[0] == '1' || d[0] == '2') && !wRep(d[1:]) && wLuhn(d)
}

func wIsrael(s string) bool {
	d := digits(s)
	if len(d) != 9 || wRep(d) {
		return false
	}
	n := 0
	for i := range 9 {
		v := int(d[i]-'0') * (i%2 + 1)
		if v > 9 {
			v -= 9
		}
		n += v
	}
	return n%10 == 0
}

func wIran(s string) bool {
	d := digits(s)
	if len(d) != 10 || wRep(d) || d[3:9] == "000000" {
		return false
	}
	r := wWeighted(d, 10, 9, 8, 7, 6, 5, 4, 3, 2) % 11
	if r < 2 {
		return int(d[9]-'0') == r
	}
	return int(d[9]-'0') == 11-r
}

func wTCKN(s string) bool {
	d := digits(s)
	if len(d) != 11 || d[0] == '0' || wRep(d) {
		return false
	}
	odd := wWeighted(d, 1, 0, 1, 0, 1, 0, 1, 0, 1)
	even := wWeighted(d, 0, 1, 0, 1, 0, 1, 0, 1)
	if ((odd*7-even)%10+10)%10 != int(d[9]-'0') {
		return false
	}
	return wWeighted(d, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)%10 == int(d[10]-'0')
}

func wZAID(s string) bool {
	d := digits(s)
	if len(d) != 13 || d[10] > '2' || (d[11] != '8' && d[11] != '9') {
		return false
	}
	return wAnyCentury(wAtoi(d[:2]), wAtoi(d[2:4]), wAtoi(d[4:6])) && wLuhn(d)
}

func wZADL(s string) bool {
	u := wUpper(s)
	return len(u) >= 10 && len(u) <= 14 && wHasLetter(u)
}

func wEgypt(s string) bool {
	d := digits(s)
	if len(d) != 14 || (d[0] != '2' && d[0] != '3') {
		return false
	}
	century := 1900
	if d[0] == '3' {
		century = 2000
	}
	if !wDate(century+wAtoi(d[1:3]), wAtoi(d[3:5]), wAtoi(d[5:7])) {
		return false
	}
	g := wAtoi(d[7:9])
	return g >= 1 && g <= 4 || g >= 11 && g <= 19 || g >= 21 && g <= 29 || g >= 31 && g <= 35 || g == 88
}

func wAlphaIndex(alphabet string, c byte) int {
	return strings.IndexByte(alphabet, c)
}

func wCURP(s string) bool {
	u := wUpper(s)
	if len(u) != 18 || !wAnyCentury(wAtoi(u[4:6]), wAtoi(u[6:8]), wAtoi(u[8:10])) {
		return false
	}
	alphabet := "0123456789ABCDEFGHIJKLMN@OPQRSTUVWXYZ"
	n := 0
	for i := range 17 {
		n += wAlphaIndex(alphabet, u[i]) * (18 - i)
	}
	return (10-n%10)%10 == int(u[17]-'0')
}

func wRFC(s string) bool {
	u := strings.ToUpper(s)
	if len(u) != 13 || !wAnyCentury(wAtoi(u[4:6]), wAtoi(u[6:8]), wAtoi(u[8:10])) {
		return false
	}
	alphabet := "0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ"
	n := 0
	for i := range 12 {
		v := wAlphaIndex(alphabet, u[i])
		if v < 0 {
			return false
		}
		n += v * (13 - i)
	}
	r := n % 11
	switch r {
	case 0:
		return u[12] == '0'
	case 1:
		return u[12] == 'A'
	}
	return u[12] == byte('0'+11-r)
}

func wCLABE(s string) bool {
	d := digits(s)
	if len(d) != 18 || wRep(d) {
		return false
	}
	n := wWeighted(d, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7)
	return (10-n%10)%10 == int(d[17]-'0')
}

func wCUIL(s string) bool {
	d := digits(s)
	if len(d) != 11 || wRep(d) {
		return false
	}
	switch d[:2] {
	case "20", "23", "24", "27":
	default:
		return false
	}
	c := 11 - wWeighted(d, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2)%11
	switch c {
	case 11:
		c = 0
	case 10:
		c = 9
	}
	return c == int(d[10]-'0')
}

func wCBU(s string) bool {
	d := digits(s)
	if len(d) != 22 || wRep(d) {
		return false
	}
	a := wWeighted(d, 7, 1, 3, 9, 7, 1, 3)
	b := wWeighted(d[8:], 3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3)
	return (10-a%10)%10 == int(d[7]-'0') && (10-b%10)%10 == int(d[21]-'0')
}

func wRUT(s string) bool {
	u := wUpper(s)
	if len(u) < 8 || len(u) > 9 {
		return false
	}
	body := u[:len(u)-1]
	if digits(body) != body || wRep(body) {
		return false
	}
	w, n := 2, 0
	for i := len(body) - 1; i >= 0; i-- {
		n += int(body[i]-'0') * w
		w++
		if w > 7 {
			w = 2
		}
	}
	c := 11 - n%11
	want := byte('0' + c)
	switch c {
	case 11:
		want = '0'
	case 10:
		want = 'K'
	}
	return u[len(u)-1] == want
}

func wEcuador(s string) bool {
	d := digits(s)
	if len(d) != 10 || d[2] > '5' {
		return false
	}
	p := wAtoi(d[:2])
	if p < 1 || (p > 24 && p != 30) {
		return false
	}
	n := 0
	for i := range 9 {
		v := int(d[i]-'0') * (2 - i%2)
		if v > 9 {
			v -= 9
		}
		n += v
	}
	return (10-n%10)%10 == int(d[9]-'0')
}

func wUruguay(s string) bool {
	d := digits(s)
	if len(d) < 7 || len(d) > 8 || wRep(d) {
		return false
	}
	body := strings.Repeat("0", 8-len(d)) + d
	n := wWeighted(body, 2, 9, 8, 7, 6, 3, 4)
	return (10-n%10)%10 == int(body[7]-'0')
}

func wDUI(s string) bool {
	d := digits(s)
	if len(d) != 9 || wRep(d) {
		return false
	}
	n := wWeighted(d, 9, 8, 7, 6, 5, 4, 3, 2)
	return (10-n%10)%10 == int(d[8]-'0')
}

func wRIF(s string) bool {
	u := wUpper(s)
	if len(u) != 10 {
		return false
	}
	base := 4
	if u[0] == 'E' {
		base = 8
	} else if u[0] != 'V' {
		return false
	}
	c := 11 - (base+wWeighted(u[1:], 3, 2, 7, 6, 5, 4, 3, 2))%11
	if c > 9 {
		c = 0
	}
	return c == int(u[9]-'0')
}

func wCuba(s string) bool {
	d := digits(s)
	if len(d) != 11 {
		return false
	}
	var century int
	switch {
	case d[6] <= '5':
		century = 1900
	case d[6] <= '8':
		century = 2000
	default:
		return wDate(1800+wAtoi(d[:2]), wAtoi(d[2:4]), wAtoi(d[4:6]))
	}
	return wDate(century+wAtoi(d[:2]), wAtoi(d[2:4]), wAtoi(d[4:6]))
}

func wIdNr(s string) bool {
	d := digits(s)
	if len(d) != 11 || d[0] == '0' {
		return false
	}
	counts := [10]int{}
	for i := range 10 {
		counts[d[i]-'0']++
	}
	repeated := 0
	for _, n := range counts {
		if n > 3 {
			return false
		}
		if n > 1 {
			repeated++
		}
	}
	return repeated == 1 && wIso7064(d)
}

func wCrossSum(n int) int {
	return n/10 + n%10
}

func wRVNR(s string) bool {
	u := wUpper(s)
	if len(u) != 12 {
		return false
	}
	day := wAtoi(u[2:4])
	month := wAtoi(u[4:6])
	validDay := day >= 1 && day <= 31 || day >= 51 && day <= 81
	if !validDay || month < 1 || month > 12 {
		return false
	}
	v := int(u[8]-'A') + 1
	eff := u[:8] + string(rune('0'+v/10)) + string(rune('0'+v%10)) + u[9:11]
	weights := [...]int{2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1}
	n := 0
	for i, w := range weights {
		n += wCrossSum(int(eff[i]-'0') * w)
	}
	return n%10 == int(u[11]-'0')
}

func wKVNR(s string) bool {
	u := wUpper(s)
	if len(u) != 10 || wRep(u[1:9]) {
		return false
	}
	v := int(u[0]-'A') + 1
	eff := string(rune('0'+v/10)) + string(rune('0'+v%10)) + u[1:9]
	n := 0
	for i := range 10 {
		n += wCrossSum(int(eff[i]-'0') * (i%2 + 1))
	}
	return n%10 == int(u[9]-'0')
}

func wICAO(u string) int {
	n := 0
	w := [...]int{7, 3, 1}
	for i := range len(u) {
		c := u[i]
		v := int(c - '0')
		if c >= 'A' && c <= 'Z' {
			v = int(c-'A') + 10
		}
		n += v * w[i%3]
	}
	return n % 10
}

func wDEDoc(s string) bool {
	u := wUpper(s)
	switch len(u) {
	case 9:
		return digits(u) != "" && wHasLetter(u)
	case 10:
		return wICAO(u[:9]) == int(u[9]-'0')
	}
	return false
}

func wLANR(s string) bool {
	d := digits(s)
	if len(d) != 9 || wRep(d) {
		return false
	}
	n := wWeighted(d, 4, 9, 4, 9, 4, 9)
	return (10-n%10)%10 == int(d[6]-'0')
}

func wNIR(s string) bool {
	u := wUpper(s)
	if len(u) != 15 {
		return false
	}
	body := u[:13]
	switch u[5:7] {
	case "2A":
		body = u[:5] + "19" + u[7:13]
	case "2B":
		body = u[:5] + "18" + u[7:13]
	}
	if digits(body) != body {
		return false
	}
	n, err := strconv.ParseInt(body, 10, 64)
	if err != nil {
		return false
	}
	return 97-int(n%97) == wAtoi(u[13:])
}

func wFRNIF(s string) bool {
	d := digits(s)
	if len(d) != 13 || d[0] > '3' {
		return false
	}
	n, err := strconv.ParseInt(d[:10], 10, 64)
	if err != nil {
		return false
	}
	return int(n%511) == wAtoi(d[10:])
}

const wDNILetters = "TRWAGMYFPDXBNJZSQVHLCKE"

func wDNI(s string) bool {
	u := wUpper(s)
	if len(u) != 9 || digits(u[:8]) != u[:8] || wRep(u[:8]) {
		return false
	}
	return wDNILetters[wAtoi(u[:8])%23] == u[8]
}

func wNIE(s string) bool {
	u := wUpper(s)
	if len(u) != 9 {
		return false
	}
	p := strings.IndexByte("XYZ", u[0])
	if p < 0 || digits(u[1:8]) != u[1:8] || u[1:8] == "0000000" {
		return false
	}
	return wDNILetters[wAtoi(strconv.Itoa(p)+u[1:8])%23] == u[8]
}

func wNUSS(s string) bool {
	d := digits(s)
	if len(d) != 12 || wRep(d) {
		return false
	}
	body := d[:10]
	if d[2] == '0' {
		body = d[:2] + d[3:10]
	}
	n, err := strconv.ParseInt(body, 10, 64)
	if err != nil {
		return false
	}
	return int(n%97) == wAtoi(d[10:])
}

func wCCCDigit(d string) int {
	n := wWeighted(d, 1, 2, 4, 8, 5, 10, 9, 7, 3, 6)
	c := 11 - n%11
	switch c {
	case 11:
		return 0
	case 10:
		return 1
	}
	return c
}

func wCCC(s string) bool {
	d := digits(s)
	if len(d) != 20 || wRep(d) {
		return false
	}
	return wCCCDigit("00"+d[:8]) == int(d[8]-'0') && wCCCDigit(d[10:]) == int(d[9]-'0')
}

func wCF(s string) bool {
	u := wUpper(s)
	if len(u) != 16 {
		return false
	}
	odd := [...]int{1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23}
	n := 0
	for i := range 15 {
		c := u[i]
		if i%2 == 0 {
			if digit(c) {
				n += odd[c-'0']
			} else {
				n += odd[c-'A']
			}
		} else if digit(c) {
			n += int(c - '0')
		} else {
			n += int(c - 'A')
		}
	}
	return byte('A'+n%26) == u[15]
}

func wPTNIF(s string) bool {
	d := digits(s)
	if len(d) != 9 || wRep(d) {
		return false
	}
	r := wWeighted(d, 9, 8, 7, 6, 5, 4, 3, 2) % 11
	c := 0
	if r >= 2 {
		c = 11 - r
	}
	return c == int(d[8]-'0')
}

func wPTCC(s string) bool {
	u := wUpper(s)
	if len(u) != 12 {
		return false
	}
	n := 0
	for i := range 12 {
		c := u[11-i]
		v := int(c - '0')
		if c >= 'A' && c <= 'Z' {
			v = int(c-'A') + 10
		}
		if i%2 == 1 {
			v *= 2
			if v > 9 {
				v -= 9
			}
		}
		n += v
	}
	return n%10 == 0
}

func wBSN(s string) bool {
	d := digits(s)
	if len(d) != 9 || wRep(d) {
		return false
	}
	n := wWeighted(d, 9, 8, 7, 6, 5, 4, 3, 2) - int(d[8]-'0')
	return n%11 == 0
}

func wBENN(s string) bool {
	d := digits(s)
	if len(d) != 11 || wRep(d) {
		return false
	}
	if wAtoi(d[2:4]) > 12 || wAtoi(d[4:6]) > 31 {
		return false
	}
	body, err := strconv.ParseInt(d[:9], 10, 64)
	if err != nil {
		return false
	}
	c := int64(wAtoi(d[9:]))
	if 97-body%97 == c {
		return true
	}
	return 2000+wAtoi(d[:2]) <= time.Now().Year() && 97-(body+2000000000)%97 == c
}

func wBEEID(s string) bool {
	d := digits(s)
	if len(d) != 12 || wRep(d) {
		return false
	}
	body, err := strconv.ParseInt(d[:10], 10, 64)
	if err != nil {
		return false
	}
	c := body % 97
	if c == 0 {
		c = 97
	}
	return c == int64(wAtoi(d[10:]))
}

func wLUMat(s string) bool {
	d := digits(s)
	if len(d) != 13 || !wDate(wAtoi(d[:4]), wAtoi(d[4:6]), wAtoi(d[6:8])) {
		return false
	}
	return wLuhn(d[:12]) && wVerhoeff(d[:11]+d[12:])
}

func wAHV(s string) bool {
	d := digits(s)
	if len(d) != 13 || !strings.HasPrefix(d, "756") {
		return false
	}
	return wWeighted(d, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1)%10 == 0
}

func wATSV(s string) bool {
	d := digits(s)
	if len(d) != 10 || d[0] == '0' {
		return false
	}
	return wWeighted(d, 3, 7, 9, 0, 5, 8, 4, 2, 1, 6)%11 == int(d[3]-'0')
}

func wSEPnr(s string) bool {
	d := digits(s)
	if len(d) == 12 {
		c := d[:2]
		if c != "18" && c != "19" && c != "20" {
			return false
		}
		d = d[2:]
	}
	if len(d) != 10 || wRep(d) {
		return false
	}
	day := wAtoi(d[4:6])
	if day > 60 {
		day -= 60
	}
	return wAnyCentury(wAtoi(d[:2]), wAtoi(d[2:4]), day) && wLuhn(d)
}

func wNOFnr(s string) bool {
	d := digits(s)
	if len(d) != 11 {
		return false
	}
	day, month, yy, ind := wAtoi(d[:2]), wAtoi(d[2:4]), wAtoi(d[4:6]), wAtoi(d[6:9])
	if day > 40 {
		day -= 40
	}
	century := 1900
	switch {
	case ind < 500:
	case ind < 750 && yy >= 54:
		century = 1800
	case yy < 40:
		century = 2000
	case ind >= 900 && yy >= 40:
	default:
		return false
	}
	if !wDate(century+yy, month, day) {
		return false
	}
	a := (11 - wWeighted(d, 3, 7, 6, 1, 8, 9, 4, 5, 2)%11) % 11
	b := (11 - wWeighted(d, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2)%11) % 11
	return a == int(d[9]-'0') && b == int(d[10]-'0')
}

func wNOKonto(s string) bool {
	d := digits(s)
	if len(d) != 11 || wRep(d) {
		return false
	}
	c := (11 - wWeighted(d, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2)%11) % 11
	return c == int(d[10]-'0')
}

func wDKCPR(s string) bool {
	d := digits(s)
	if len(d) != 10 {
		return false
	}
	yy := wAtoi(d[4:6])
	century := 1900
	switch d[6] {
	case '0', '1', '2', '3':
	case '4', '9':
		if yy < 37 {
			century = 2000
		}
	default:
		if yy < 58 {
			century = 2000
		} else {
			century = 1800
		}
	}
	return wDate(century+yy, wAtoi(d[2:4]), wAtoi(d[:2]))
}

func wHetu(s string) bool {
	u := strings.ToUpper(s)
	if len(u) != 11 {
		return false
	}
	century := 2000
	switch u[6] {
	case '+':
		century = 1800
	case '-', 'Y', 'X', 'W', 'V', 'U':
		century = 1900
	}
	if !wDate(century+wAtoi(u[4:6]), wAtoi(u[2:4]), wAtoi(u[:2])) {
		return false
	}
	serial := wAtoi(u[7:10])
	if serial < 2 || serial > 899 {
		return false
	}
	n := wAtoi(u[:6] + u[7:10])
	return "0123456789ABCDEFHJKLMNPRSTUVWXY"[n%31] == u[10]
}

func wKennitala(s string) bool {
	d := digits(s)
	if len(d) != 10 {
		return false
	}
	century := 0
	switch d[9] {
	case '9':
		century = 1900
	case '0':
		century = 2000
	default:
		return false
	}
	if !wDate(century+wAtoi(d[4:6]), wAtoi(d[2:4]), wAtoi(d[:2])) {
		return false
	}
	r := wWeighted(d, 3, 2, 7, 6, 5, 4, 3, 2) % 11
	c := 0
	if r != 0 {
		c = 11 - r
	}
	return c == int(d[8]-'0')
}

func wPESEL(s string) bool {
	d := digits(s)
	if len(d) != 11 || wRep(d) {
		return false
	}
	m := wAtoi(d[2:4])
	century := 1900
	switch {
	case m > 80:
		century, m = 1800, m-80
	case m > 60:
		century, m = 2200, m-60
	case m > 40:
		century, m = 2100, m-40
	case m > 20:
		century, m = 2000, m-20
	}
	if !wDate(century+wAtoi(d[:2]), m, wAtoi(d[4:6])) {
		return false
	}
	n := wWeighted(d, 1, 3, 7, 9, 1, 3, 7, 9, 1, 3)
	return (10-n%10)%10 == int(d[10]-'0')
}

func wNIP(s string) bool {
	d := digits(s)
	if len(d) != 10 || wRep(d) {
		return false
	}
	return wWeighted(d, 6, 5, 7, 2, 3, 4, 5, 6, 7)%11 == int(d[9]-'0')
}

func wPLID(s string) bool {
	u := wUpper(s)
	if len(u) != 9 {
		return false
	}
	w := [...]int{7, 3, 1, 9, 7, 3, 1, 7, 3}
	n := 0
	for i, x := range w {
		c := u[i]
		v := int(c - '0')
		if c >= 'A' && c <= 'Z' {
			v = int(c-'A') + 10
		}
		n += v * x
	}
	return n%10 == 0
}

func wCZRC(s string) bool {
	d := digits(s)
	if len(d) != 9 && len(d) != 10 {
		return false
	}
	yy := wAtoi(d[:2])
	century := 1900
	if len(d) == 10 && yy < 54 {
		century = 2000
	}
	if len(d) == 9 && (yy > 53 || d[6:] == "000") {
		return false
	}
	m := wAtoi(d[2:4])
	if m > 50 {
		m -= 50
	}
	if m > 20 {
		if century+yy < 2004 {
			return false
		}
		m -= 20
	}
	if !wDate(century+yy, m, wAtoi(d[4:6])) {
		return false
	}
	if len(d) == 9 {
		return true
	}
	n, err := strconv.ParseInt(d, 10, 64)
	if err != nil {
		return false
	}
	if n%11 == 0 {
		return true
	}
	head, err := strconv.ParseInt(d[:9], 10, 64)
	return err == nil && century+yy < 1986 && head%11 == 10 && d[9] == '0'
}

func wTAJ(s string) bool {
	d := digits(s)
	if len(d) != 9 || wRep(d) {
		return false
	}
	return wWeighted(d, 3, 7, 3, 7, 3, 7, 3, 7)%10 == int(d[8]-'0')
}

func wHUTax(s string) bool {
	d := digits(s)
	if len(d) != 10 || d[0] != '8' {
		return false
	}
	return wWeighted(d, 1, 2, 3, 4, 5, 6, 7, 8, 9)%11 == int(d[9]-'0')
}

func wCNP(s string) bool {
	d := digits(s)
	if len(d) != 13 || d[0] == '0' {
		return false
	}
	century := 1900
	switch d[0] {
	case '3', '4':
		century = 1800
	case '5', '6':
		century = 2000
	case '7', '8', '9':
		if !wAnyCentury(wAtoi(d[1:3]), wAtoi(d[3:5]), wAtoi(d[5:7])) {
			return false
		}
		century = -1
	}
	if century > 0 && !wDate(century+wAtoi(d[1:3]), wAtoi(d[3:5]), wAtoi(d[5:7])) {
		return false
	}
	county := wAtoi(d[7:9])
	validCounty := county >= 1 && county <= 48 || county == 51 || county == 52 || county == 70 || county >= 80 && county <= 83
	if !validCounty {
		return false
	}
	c := wWeighted(d, 2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9) % 11
	if c == 10 {
		c = 1
	}
	return c == int(d[12]-'0')
}

func wEGN(s string) bool {
	d := digits(s)
	if len(d) != 10 {
		return false
	}
	m := wAtoi(d[2:4])
	century := 1900
	switch {
	case m > 40:
		century, m = 2000, m-40
	case m > 20:
		century, m = 1800, m-20
	}
	if !wDate(century+wAtoi(d[:2]), m, wAtoi(d[4:6])) {
		return false
	}
	c := wWeighted(d, 2, 4, 8, 5, 10, 9, 7, 3, 6) % 11
	if c == 10 {
		c = 0
	}
	return c == int(d[9]-'0')
}

func wOIB(s string) bool {
	d := digits(s)
	return len(d) == 11 && !wRep(d) && wIso7064(d)
}

func wJMBG(s string) bool {
	d := digits(s)
	if len(d) != 13 {
		return false
	}
	y := wAtoi(d[4:7])
	if y >= 800 {
		y += 1000
	} else {
		y += 2000
	}
	if !wDate(y, wAtoi(d[2:4]), wAtoi(d[:2])) {
		return false
	}
	c := 11 - wWeighted(d, 7, 6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2)%11
	if c >= 10 {
		c = 0
	}
	return c == int(d[12]-'0')
}

func wSITax(s string) bool {
	d := digits(s)
	if len(d) != 8 || d[0] == '0' || wRep(d) {
		return false
	}
	c := 11 - wWeighted(d, 8, 7, 6, 5, 4, 3, 2)%11
	if c == 10 {
		c = 0
	}
	return c == int(d[7]-'0')
}

func wAMKA(s string) bool {
	d := digits(s)
	return len(d) == 11 && wAnyCentury(wAtoi(d[4:6]), wAtoi(d[2:4]), wAtoi(d[:2])) && wLuhn(d)
}

func wAFM(s string) bool {
	d := digits(s)
	if len(d) != 9 || wRep(d) {
		return false
	}
	return wWeighted(d, 256, 128, 64, 32, 16, 8, 4, 2)%11%10 == int(d[8]-'0')
}

func wCYTIC(s string) bool {
	u := wUpper(s)
	if len(u) != 9 {
		return false
	}
	n := 0
	for i := range 8 {
		v := int(u[i] - '0')
		if i%2 == 1 {
			n += v
			continue
		}
		if v < 2 {
			n += 1 - v
			continue
		}
		n += 2*(v-2) + 5
		if v > 4 {
			n += 2
		}
	}
	return byte('A'+n%26) == u[8]
}

func wEEIK(s string) bool {
	d := digits(s)
	if len(d) != 11 || d[0] == '0' || d[0] > '6' {
		return false
	}
	century := 1800 + 100*(int(d[0]-'1')/2)
	if !wDate(century+wAtoi(d[1:3]), wAtoi(d[3:5]), wAtoi(d[5:7])) {
		return false
	}
	c := wWeighted(d, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1) % 11
	if c == 10 {
		c = wWeighted(d, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3) % 11
		if c == 10 {
			c = 0
		}
	}
	return c == int(d[10]-'0')
}

func wLVPK(s string) bool {
	d := digits(s)
	if len(d) != 11 || wRep(d) {
		return false
	}
	if d[:2] == "32" {
		return true
	}
	century := 1800 + 100*int(d[6]-'0')
	if d[6] > '2' || !wDate(century+wAtoi(d[4:6]), wAtoi(d[2:4]), wAtoi(d[:2])) {
		return false
	}
	n := 1101 - wWeighted(d, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
	return ((n%11)%10+10)%10 == int(d[10]-'0') && n%11 >= 0
}

func wUARNTRC(s string) bool {
	d := digits(s)
	if len(d) != 10 || wRep(d) {
		return false
	}
	n := wWeighted(d, -1, 5, 7, 9, 4, 6, 10, 5, 7)
	return ((n%11+11)%11)%10 == int(d[9]-'0')
}

func wRUINN(s string) bool {
	d := digits(s)
	if len(d) != 12 || wRep(d) {
		return false
	}
	a := wWeighted(d, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8) % 11 % 10
	b := wWeighted(d, 3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8) % 11 % 10
	return a == int(d[10]-'0') && b == int(d[11]-'0')
}

func wSNILS(s string) bool {
	d := digits(s)
	if len(d) != 11 || wRep(d[:9]) {
		return false
	}
	n := wWeighted(d, 9, 8, 7, 6, 5, 4, 3, 2, 1)
	if n >= 100 {
		n %= 101
		if n == 100 {
			n = 0
		}
	}
	return n == wAtoi(d[9:])
}

func wKZIIN(s string) bool {
	d := digits(s)
	if len(d) != 12 || d[6] < '1' || d[6] > '6' {
		return false
	}
	century := 1800 + 100*(int(d[6]-'1')/2)
	if !wDate(century+wAtoi(d[:2]), wAtoi(d[2:4]), wAtoi(d[4:6])) {
		return false
	}
	c := wWeighted(d, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11) % 11
	if c == 10 {
		c = wWeighted(d, 3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2) % 11
		if c == 10 {
			return false
		}
	}
	return c == int(d[11]-'0')
}

func wDEA(s string) bool {
	u := wUpper(s)
	if len(u) != 9 {
		return false
	}
	n := wWeighted(u[2:], 1, 2, 1, 2, 1, 2)
	return n%10 == int(u[8]-'0')
}

func wHasLetter(s string) bool {
	return strings.ContainsAny(strings.ToUpper(s), "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
}

func wCONIT(s string) bool {
	d := digits(s)
	if len(d) < 8 || len(d) > 16 || wRep(d) {
		return false
	}
	weights := []int{3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71}
	sum := 0
	for i := 1; i < len(d); i++ {
		sum += int(d[len(d)-1-i]-'0') * weights[i-1]
	}
	v := sum % 11
	if v > 1 {
		v = 11 - v
	}
	return int(d[len(d)-1]-'0') == v
}

func wOnderwijs(s string) bool {
	d := digits(s)
	if len(d) != 9 || wRep(d) || d[:2] != "10" {
		return false
	}
	sum := 0
	for i := range 8 {
		sum += int(d[i]-'0') * (9 - i)
	}
	sum -= int(d[8] - '0')
	return sum%11 == 5
}
