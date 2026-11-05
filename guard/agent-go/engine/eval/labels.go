// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package eval

const Other = "OTHER"

var canonical = map[string][]string{
	"NAME":            {"CUSTOMER_NAME", "HUSBAND_NAME"},
	"ADDRESS":         {"CUSTOMER_ADDRESS", "HOME_ADDRESS"},
	"PHONE":           {"MOBILE_NUMBER", "PHONE_NUMBER", "CUSTOMER_MOBILE", "CUSTOMER_PHONE", "CUSTOMER_MOBILE_NUMBER", "CONTACT_NUMBER", "CONTACT_PHONE", "PHONE"},
	"EMAIL":           {"EMAIL_ADDRESS", "CUSTOMER_EMAIL", "EMAIL", "CONTACT_EMAIL", "CUSTOMER_EMAIL_ADDRESS"},
	"DATE_OF_BIRTH":   {"DATE_OF_BIRTH", "CUSTOMER_DOB", "DOB", "CUSTOMER_DATE_OF_BIRTH"},
	"MEDICARE":        {"MEDICARE_NUMBER", "CUSTOMER_MEDICARE"},
	"TFN":             {"TAX_FILE_NUMBER", "CUSTOMER_TFN", "TAX_ID_NUMBER", "CUSTOMER_TAX_ID"},
	"DRIVERS_LICENCE": {"DRIVERS_LICENCE", "DRIVER_LICENSE", "DRIVERS_LICENSE", "DRIVER_LICENCE", "LICENCE_NUMBER", "LICENSE_NUMBER", "CUSTOMER_LICENCE", "CUSTOMER_LICENSE", "CUSTOMER_DRIVERS_LICENCE", "DRIVER_LICENSE_NUMBER"},
	"BANK_ACCOUNT":    {"BANK_ACCOUNT", "BANK_ACCOUNT_NUMBER", "CUSTOMER_BANK_ACCOUNT", "BANK_ACCOUNT_DETAILS", "BANK_DETAILS", "BANK_BSB", "BANK_ACCOUNT_BSB", "CUSTOMER_BANK"},
	"POLICY_NUMBER":   {"POLICY_NUMBER", "CUSTOMER_POLICY_NUMBER", "INSURANCE_POLICY"},
}

var rawToCanonical = func() map[string]string {
	out := map[string]string{}
	for c, raws := range canonical {
		for _, r := range raws {
			out[r] = c
		}
	}
	return out
}()

func Canonical(raw string) string {
	if c, ok := rawToCanonical[raw]; ok {
		return c
	}
	return Other
}

var KindLabels = map[string]string{
	"au-tfn":      "TFN",
	"au-medicare": "MEDICARE",
	"email-bulk":  "EMAIL",
	"phone-bulk":  "PHONE",
	"person-name": "NAME",
	"location":    "ADDRESS",
}

func kindLabel(kind string) (string, bool) {
	if l, ok := KindLabels[kind]; ok {
		return l, true
	}
	if _, ok := canonical[kind]; ok {
		return kind, true
	}
	return "", false
}

func LabelOrder() []string {
	return []string{"NAME", "ADDRESS", "PHONE", "EMAIL", "DATE_OF_BIRTH", "MEDICARE", "TFN", "DRIVERS_LICENCE", "BANK_ACCOUNT", "POLICY_NUMBER", Other}
}
