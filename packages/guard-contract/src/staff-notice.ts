// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

export const GUARD_STAFF_NOTICE_PLACEHOLDERS = ["orgName", "startDate", "contact"] as const;

export const GUARD_STAFF_NOTICE_TEMPLATE = `Notice of computer surveillance: AI services on work laptops

{{orgName}} uses Vibtra Guard on company laptops from {{startDate}}.

What it does
- It records which AI services (for example ChatGPT, Claude, Gemini, Copilot) are used from your laptop: the service, the app that used it, the time, and the size of what was sent.
- It checks what is sent to those services against the company's rules: tax file numbers, Medicare numbers, payment card numbers, API keys and other secrets, bulk email addresses, certain file types, and words the company lists.
- When a rule applies it may block the request and show you a page where you can ask IT for access, or direct you to the company's Vibtra workspace.

What it does not do
- It does not read or keep the content of what you send. The company sees the rule that applied, the kind of match and a count, and at most a redacted fragment such as "123***782".
- It does not inspect traffic to anything other than the listed AI services. All other sites and apps are untouched.
- It does not record keystrokes, screenshots or files on your laptop.

How and when
- The surveillance is continuous while the laptop is on and connected, and ongoing until you are told otherwise.
- The rules and the list of AI services are set by {{contact}} and may change; the current rules are shown on the block page when one applies.

Questions: {{contact}}
`;

export const renderStaffNotice = (template: string, values: Partial<Record<(typeof GUARD_STAFF_NOTICE_PLACEHOLDERS)[number], string>>): string =>
  template.replace(/\{\{(orgName|startDate|contact)\}\}/g, (whole, key: (typeof GUARD_STAFF_NOTICE_PLACEHOLDERS)[number]) => values[key] ?? whole);
