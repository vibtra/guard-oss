// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use vibtra_guard_agent::body::{extract, inspectable};

#[test]
fn json_strings_are_collected() {
    let e = extract(Some("application/json; charset=utf-8"), br#"{"a":"one","b":[{"c":"two"},3],"d":null}"#);
    assert_eq!(e.text, "one\ntwo\n3\n");
}

#[test]
fn a_json_string_that_holds_json_is_read_as_json() {
    let e = extract(Some("application/json"), br#"{"m":"{\"type\":\"user\",\"text\":\"0491 570 313\\n0491 570 110\"}","n":"{not json"}"#);
    assert_eq!(e.text, "0491 570 313\n0491 570 110\nuser\n{not json\n");
}

#[test]
fn same_path_fields_are_joined() {
    let e = extract(Some("application/json"), br#"{"messages":[{"content":[{"type":"text","text":"TFN 123 45"},{"type":"text","text":"6 782"}]}],"x":"y"}"#);
    assert_eq!(e.joined, vec!["TFN 123 456 782".to_string(), "texttext".to_string()]);
}

#[test]
fn form_values_are_decoded() {
    let e = extract(Some("application/x-www-form-urlencoded"), b"q=123+456+782&x=a%20b");
    assert_eq!(e.text, "123 456 782\na b\n");
}

#[test]
fn multipart_text_and_filenames() {
    let body = b"--XYZ\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\nhello there\r\n--XYZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"staff.xlsx\"\r\nContent-Type: application/octet-stream\r\n\r\nPK\x03\x04binary\r\n--XYZ--\r\n";
    let e = extract(Some("multipart/form-data; boundary=XYZ"), body);
    assert_eq!(e.text, "hello there\n");
    assert_eq!(e.filenames, vec!["staff.xlsx".to_string()]);
}

#[test]
fn inspectable_types() {
    assert!(inspectable(Some("application/json")));
    assert!(inspectable(Some("text/plain;charset=UTF-8")));
    assert!(inspectable(Some("application/vnd.api+json")));
    assert!(!inspectable(Some("application/octet-stream")));
    assert!(inspectable(None), "an absent Content-Type is read as text/plain");
    assert_eq!(extract(None, b"tfn 123 456 782").text, "tfn 123 456 782");
}
