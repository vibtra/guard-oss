// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package engine

import "errors"

func Validate(v Decision) error {
	if v.Intercepted != (v.Service != nil) || v.Service != nil && v.Flow == nil {
		return errors.New("engine decision: an intercepted decision needs a service and a flow, and only an intercepted one may have them")
	}
	if v.Content != nil && (v.Content.Decided < -1 || v.Content.Decided >= len(v.Content.Matches)) {
		return errors.New("engine decision: content.Decided must be -1 or the index of a match")
	}
	return nil
}
