// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use vibtra_guard_agent::agent::BlockInfo;
use vibtra_guard_agent::page::{esc, message, render};
use vibtra_guard_agent::types::{Action, AskView};

const BASE: &str = "http://127.0.0.1:9471";
const EV: &str = "gev_0000000000000001";

fn info(rule_kind: &str, action: Action) -> BlockInfo {
    BlockInfo {
        event_id: EV.into(),
        occurred_at: "2026-10-16T09:30:12.000Z".into(),
        service_id: "openai-chatgpt".into(),
        service_name: "ChatGPT".into(),
        host: "chatgpt.com".into(),
        action,
        rule_id: Some(if rule_kind == "content" { "gcr_00000001" } else { "gsr_00000001" }.into()),
        rule_name: (rule_kind == "content").then(|| "Tax file numbers".to_string()),
        rule_kind: rule_kind.into(),
        match_type: (rule_kind == "content").then(|| "au-tfn".to_string()),
        match_count: (rule_kind == "content").then_some(3),
        example: (rule_kind == "content").then(|| "123***782".to_string()),
        note: Some("A TFN is never pasted into an AI service.".into()),
        app: Some("Google Chrome".into()),
        requests_enabled: true,
        workspace: Some("https://fernwood.example/workspace".into()),
        enforced: true,
    }
}

fn ask(status: &str) -> AskView {
    AskView {
        request_id: "pr_0001".into(),
        kind: "guard".into(),
        status: status.into(),
        subject: serde_json::json!({ "serviceId": "openai-chatgpt" }),
        created_at: "2026-10-16T00:00:00.000Z".into(),
        expires_at: "2026-10-30T00:00:00.000Z".into(),
        decided_at: None,
        decision_note: None,
        grant_expires_at: None,
    }
}

fn title_of(html: &str) -> &str {
    let start = html.find("<title>").unwrap() + "<title>".len();
    &html[start..html[start..].find("</title>").unwrap() + start]
}

fn h1_of(html: &str) -> &str {
    let start = html.find("<h1>").unwrap() + "<h1>".len();
    &html[start..html[start..].find("</h1>").unwrap() + start]
}

#[test]
fn esc_covers_the_five_html_specials() {
    assert_eq!(esc(r#"<a href="x">Tom & Jerry's</a>"#), "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;");
    assert_eq!(esc("plain — ünïcode"), "plain — ünïcode");
    assert_eq!(esc(""), "");
}

#[test]
fn a_custom_service_name_host_and_note_are_escaped_everywhere() {
    let mut i = info("service", Action::Block);
    i.service_id = "custom-internal".into();
    i.service_name = r#"<script>alert("x")</script> & 'Co'"#.into();
    i.host = "evil<b>.example".into();
    i.note = Some("<img src=x onerror=alert(1)>".into());
    i.app = Some("<svg onload=1>".into());
    i.rule_name = Some("Rule \"one\" <b>".into());
    let html = render(&i, None, false, BASE);
    for raw in ["<script>alert", "<img src=x", "<b>.example", "<svg onload", "Rule \"one\" <b>"] {
        assert!(!html.contains(raw), "`{raw}` reached the page unescaped");
    }
    let escaped_name = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;";
    assert_eq!(h1_of(&html), format!("{escaped_name} is blocked on this laptop"));
    assert_eq!(title_of(&html), format!("{escaped_name} is blocked on this laptop · Vibtra Guard"));
    assert!(!html.contains("&amp;lt;") && !html.contains("&amp;#39;") && !html.contains("&amp;quot;"));
    assert!(html.contains("evil&lt;b&gt;.example"));
    assert!(html.contains("This is blocked because: &lt;img src=x onerror=alert(1)&gt;"));
    assert!(html.contains("&lt;svg onload=1&gt;"));
    let html = render(&i, Some(&ask("pending")), false, BASE);
    assert_eq!(title_of(&html), format!("Waiting for IT: {escaped_name} is blocked on this laptop · Vibtra Guard"));
}

#[test]
fn the_four_titles_and_explanations() {
    let cases = [
        ("content", Action::Block, "This was not sent to ChatGPT", "Vibtra Guard stopped this request because it contained a tax file number (3 found)."),
        (
            "content",
            Action::Ask,
            "Sending this to ChatGPT needs IT&#39;s OK",
            "Vibtra Guard stopped this request because it contained a tax file number (3 found).",
        ),
        ("service", Action::Block, "ChatGPT is blocked on this laptop", "Your organisation does not allow this AI service from work laptops."),
        ("default", Action::Ask, "Using ChatGPT needs IT&#39;s OK", "Your organisation asks people to get IT&#39;s OK before using this AI service."),
    ];
    for (kind, action, title, lead) in cases {
        let html = render(&info(kind, action), None, false, BASE);
        assert_eq!(h1_of(&html), title, "{kind}/{action:?}");
        assert!(html.contains(&format!("<p>{lead}</p>")), "{kind}/{action:?}: lead");
        assert_eq!(html.contains("class=\"dot ask\""), action == Action::Ask, "the ask dot is amber");
        if kind == "content" {
            assert!(html.contains("<dt>Rule</dt><dd>Tax file numbers</dd>"));
            assert!(html.contains("<dt>Found</dt><dd>a tax file number: 123***782</dd>"));
        } else {
            assert!(!html.contains("<dt>Found</dt>"));
        }
    }
    let mut one = info("content", Action::Block);
    one.match_count = Some(1);
    assert!(render(&one, None, false, BASE).contains("contained a tax file number.</p>"));
    let html = render(&info("service", Action::Block), None, false, BASE);
    assert!(html.contains(&format!("<span>Event {EV}</span> · <span>2026-10-16 09:30 UTC</span>")));
}

#[test]
fn the_ask_status_matrix() {
    let i = info("content", Action::Block);
    let poll = format!("\"{BASE}/blocked/{EV}/status\"");
    let form = format!("<form method=\"post\" action=\"{BASE}/blocked/{EV}/request\">");

    let html = render(&i, None, false, BASE);
    assert!(html.contains(&form) && !html.contains(&poll) && !html.contains("id=\"ask\""));
    assert!(title_of(&html).starts_with("This was not sent"));

    let html = render(&i, Some(&ask("pending")), false, BASE);
    assert!(html.contains("<strong>Waiting for IT.</strong>") && html.contains("role=\"status\""));
    assert!(html.contains(&poll), "a pending ask polls its status");
    assert!(!html.contains(&form));
    assert!(title_of(&html).starts_with("Waiting for IT: "));

    let mut approved = ask("approved");
    approved.grant_expires_at = Some("2099-10-23T00:00:00.000Z".into());
    let html = render(&i, Some(&approved), false, BASE);
    assert!(html.contains("<strong>Approved until 2099-10-23 00:00 UTC.</strong> Applying the new rules to this laptop…"));
    assert!(html.contains(&poll) && !html.contains(&form));
    assert!(title_of(&html).starts_with("Approved: "));

    let html = render(&i, Some(&approved), true, BASE);
    assert!(html.contains("<strong>Approved until 2099-10-23 00:00 UTC.</strong> Try again."));
    assert!(!html.contains(&poll) && !html.contains(&form));
    assert!(render(&i, Some(&ask("approved")), true, BASE).contains("<strong>Approved.</strong> Try again."));

    let mut declined = ask("declined");
    declined.decision_note = Some("Use the <b>workspace</b>".into());
    let closed = [
        (declined, "IT declined this request.", "IT declined: ", Some(" IT said: “Use the &lt;b&gt;workspace&lt;/b&gt;”")),
        (ask("expired"), "This request expired before IT decided.", "Request expired: ", None),
        (ask("cancelled"), "This request was cancelled.", "Request cancelled: ", None),
        (ask("replaced"), "This request was replaced by a newer one.", "Request replaced: ", None),
    ];
    for (a, sentence, title, note) in closed {
        let html = render(&i, Some(&a), false, BASE);
        assert!(html.contains(&format!("<div class=\"status no\" id=\"ask\" role=\"status\"><strong>{sentence}</strong>")), "{}", a.status);
        if let Some(n) = note {
            assert!(html.contains(n), "the decision note");
        }
        assert!(title_of(&html).starts_with(title), "{}", a.status);
        assert!(!html.contains(&poll), "{}: no poll", a.status);
        assert!(html.contains(&form), "{}: the person may ask again", a.status);
    }
}

#[test]
fn monitor_mode_says_it_let_the_request_through() {
    let mut i = info("service", Action::Block);
    assert!(!render(&i, None, false, BASE).contains("<dt>Mode</dt>"));
    i.enforced = false;
    assert!(render(&i, None, false, BASE).contains("<dt>Mode</dt><dd>Monitor: this request was let through and recorded</dd>"));
}

#[test]
fn the_workspace_button_and_the_form_follow_the_settings() {
    let button = format!("<a class=\"btn secondary\" href=\"{BASE}/blocked/{EV}/workspace\">Use the company Vibtra workspace</a>");
    let form = "<form method=\"post\"";
    let html = render(&info("service", Action::Block), None, false, BASE);
    assert!(html.contains(form) && html.contains(&button));
    let mut i = info("service", Action::Block);
    i.requests_enabled = false;
    let html = render(&i, None, false, BASE);
    assert!(!html.contains(form) && html.contains(&format!("<div class=\"row\">{button}</div>")));
    let mut i = info("service", Action::Block);
    i.workspace = None;
    let html = render(&i, None, false, BASE);
    assert!(html.contains(form) && !html.contains("Use the company Vibtra workspace"));
    i.requests_enabled = false;
    let html = render(&i, None, false, BASE);
    assert!(!html.contains(form) && !html.contains("class=\"row\""));
    let html = render(&info("service", Action::Block), Some(&ask("pending")), false, BASE);
    assert!(!html.contains(form) && html.contains(&button));
}

#[test]
fn the_message_page_escapes_its_words() {
    let html = message("Gone <now>", "Try \"again\" & 'later'");
    assert_eq!(title_of(&html), "Gone &lt;now&gt; · Vibtra Guard");
    assert!(html.contains("<h1>Gone &lt;now&gt;</h1><p>Try &quot;again&quot; &amp; &#39;later&#39;</p>"));
}
