//! Settings of the window's WKWebView that Tauri doesn't expose.

use tauri::{App, Manager};

/// Lets the web view draw at the display's refresh rate. WebKit holds pages to about 60 frames a
/// second unless told otherwise (Safari tells it), so on a 120 Hz display typing and scrolling
/// update half as often as in the system's own text fields, or in apps built on Chromium.
pub fn render_at_display_rate(app: &App) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.with_webview(|webview| {
        #[cfg(target_os = "macos")]
        // SAFETY: `inner` is the window's WKWebView. The feature list and its setter are WebKit's
        // private API, so each is checked for before it's used: without them nothing changes.
        unsafe {
            disable_feature(webview.inner().cast(), c"PreferPageRenderingUpdatesNear60FPSEnabled")
        };
    });
}

#[cfg(target_os = "macos")]
unsafe fn disable_feature(webview: *mut objc2::runtime::AnyObject, key: &std::ffi::CStr) {
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};

    let Some(class) = AnyClass::get(c"WKPreferences") else { return };
    let setter = sel!(_setEnabled:forFeature:);
    let has: Bool = msg_send![class, respondsToSelector: sel!(_features)];
    let can: Bool = msg_send![class, instancesRespondToSelector: setter];
    if webview.is_null() || !has.as_bool() || !can.as_bool() {
        return;
    }
    let configuration: *mut AnyObject = msg_send![webview, configuration];
    let preferences: *mut AnyObject = msg_send![configuration, preferences];
    let features: *mut AnyObject = msg_send![class, _features];
    if preferences.is_null() || features.is_null() {
        return;
    }
    let count: usize = msg_send![features, count];
    for i in 0..count {
        let feature: *mut AnyObject = msg_send![features, objectAtIndex: i];
        let name: *mut AnyObject = msg_send![feature, key];
        let utf8: *const std::ffi::c_char = msg_send![name, UTF8String];
        if !utf8.is_null() && std::ffi::CStr::from_ptr(utf8) == key {
            let _: () = msg_send![preferences, _setEnabled: Bool::NO, forFeature: feature];
            return;
        }
    }
}
