// Native callback regressions. Run with npm run test:native-browser on macOS.
#[path = "nativeBrowserStreams.rs"]
mod native_browser_streams;
use objc2::{
    define_class, msg_send, rc::Retained, runtime::ProtocolObject, sel, ClassType, DefinedClass,
    Message,
};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSWindow, NSWindowStyleMask,
};
use objc2_foundation::{
    ns_string, MainThreadMarker, NSData, NSDate, NSError, NSObject,
    NSObjectNSKeyValueObserverNotification, NSObjectProtocol, NSPoint, NSRect, NSRunLoop, NSSize,
    NSString, NSURLRequest, NSURLResponse, NSURL,
};
use objc2_web_kit::{
    WKDownload, WKDownloadDelegate, WKNavigationAction, WKNavigationActionPolicy,
    WKNavigationDelegate, WKUIDelegate, WKWebView, WKWebViewConfiguration, WKWindowFeatures,
};
use raw_window_handle::{AppKitWindowHandle, WindowHandle};
use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::Rc,
    sync::mpsc,
    time::{Duration, Instant},
};
use wry::{NewWindowResponse, PageLoadEvent, WebViewBuilder, WebViewExtMacOS};

fn wait_until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ready() {
        assert!(Instant::now() < deadline, "native callback timed out");
        NSRunLoop::mainRunLoop().runMode_beforeDate(
            ns_string!("NSDefaultRunLoopMode"),
            &NSDate::dateWithTimeIntervalSinceNow(0.01),
        );
    }
}

fn test_empty_url(handle: &WindowHandle<'_>) {
    let browser = WebViewBuilder::new()
        .with_incognito(true)
        .build_as_child(handle)
        .unwrap();
    assert!(unsafe { browser.webview().URL() }.is_none());
    assert!(browser.url().is_err());
    println!("PASS: reading a WebView URL before navigation returns an error");
}

fn test_empty_title(handle: &WindowHandle<'_>) {
    let titles = Rc::new(RefCell::new(Vec::new()));
    let received = titles.clone();
    let browser = WebViewBuilder::new()
        .with_incognito(true)
        .with_document_title_changed_handler(move |title| received.borrow_mut().push(title))
        .build_as_child(handle)
        .unwrap();
    let native = browser.webview();
    // WKWebView.title is nullable, though a fresh view currently returns "".
    // Supply nil only during this synchronous KVO delivery; restore the getter
    // before running the event loop or using any other views in this process.
    let getter = WKWebView::class().instance_method(sel!(title)).unwrap();
    let nil_getter = NilTitle::class().instance_method(sel!(title)).unwrap();
    unsafe {
        getter.exchange_implementation(nil_getter);
    }
    assert!(unsafe { native.title() }.is_none());
    // Deliver KVO through WebKit's real registered title observer.
    native.willChangeValueForKey(ns_string!("title"));
    native.didChangeValueForKey(ns_string!("title"));
    unsafe {
        getter.exchange_implementation(nil_getter);
    }
    assert_eq!(&*titles.borrow(), &[String::new()]);
    println!("PASS: a nil title notification clears the title safely");
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "QmuxProbeNilTitle"]
    struct NilTitle;
    unsafe impl NSObjectProtocol for NilTitle {}
    impl NilTitle {
        #[unsafe(method_id(title))]
        fn title(&self) -> Option<Retained<NSString>> { None }
    }
);

fn test_empty_navigation(handle: &WindowHandle<'_>) {
    let loads = Rc::new(RefCell::new(Vec::new()));
    let received = loads.clone();
    let browser = WebViewBuilder::new()
        .with_incognito(true)
        .with_on_page_load_handler(move |event, url| {
            received
                .borrow_mut()
                .push((matches!(event, PageLoadEvent::Finished), url));
        })
        .build_as_child(handle)
        .unwrap();
    let native = browser.webview();
    let delegate = unsafe { native.navigationDelegate().unwrap() };
    unsafe {
        delegate.webView_didCommitNavigation(&native, None);
        delegate.webView_didFinishNavigation(&native, None);
    }
    assert_eq!(
        &*loads.borrow(),
        &[(false, String::new()), (true, String::new()),]
    );
    println!("PASS: load callbacks handle nil navigation and URL data");
}

fn test_eval_results(handle: &WindowHandle<'_>) {
    let loaded = Rc::new(Cell::new(false));
    let on_load = loaded.clone();
    let titles = Rc::new(RefCell::new(Vec::new()));
    let received_titles = titles.clone();
    let browser = WebViewBuilder::new()
        .with_incognito(true)
        .with_html("<!doctype html><title>Callback test</title>")
        .with_document_title_changed_handler(move |title| received_titles.borrow_mut().push(title))
        .with_on_page_load_handler(move |event, _| {
            if matches!(event, PageLoadEvent::Finished) {
                on_load.set(true);
            }
        })
        .build_as_child(handle)
        .unwrap();
    wait_until(|| loaded.get());
    assert_eq!(browser.url().unwrap(), "about:blank");
    wait_until(|| titles.borrow().iter().any(|title| title == "Callback test"));
    for (script, expected) in [
        ("NaN", ""),
        ("Infinity", ""),
        ("({nested: [NaN]})", ""),
        ("new Date(0)", ""),
        ("undefined", ""),
        ("throw new Error('probe')", ""),
        ("null", "null"),
        ("42", "42"),
        ("true", "true"),
        ("'hello'", "\"hello\""),
        ("({value: [1, null, true]})", "{\"value\":[1,null,true]}"),
    ] {
        let (send, receive) = mpsc::channel();
        browser
            .evaluate_script_with_callback(script, move |result| send.send(result).unwrap())
            .unwrap();
        let mut result = None;
        wait_until(|| {
            result = receive.try_recv().ok();
            result.is_some()
        });
        assert_eq!(result.unwrap(), expected, "script: {script}");
        assert!(
            receive.try_recv().is_err(),
            "callback delivered more than once"
        );
        println!("PASS: JavaScript callback result for {script}");
    }
}

define_class!(
    #[unsafe(super(WKNavigationAction))]
    #[name = "QmuxProbeNavigationAction"]
    #[ivars = Retained<NSURLRequest>]
    struct ProbeAction;
    unsafe impl NSObjectProtocol for ProbeAction {}
    impl ProbeAction {
        #[unsafe(method_id(request))]
        fn request(&self) -> Retained<NSURLRequest> { self.ivars().clone() }
        #[unsafe(method(shouldPerformDownload))]
        fn should_perform_download(&self) -> bool { false }
    }
);
impl ProbeAction {
    fn new(mtm: MainThreadMarker, request: Retained<NSURLRequest>) -> Retained<Self> {
        let action = mtm.alloc::<Self>().set_ivars(request);
        unsafe { msg_send![super(action), init] }
    }
}

struct DownloadState {
    request: Option<Retained<NSURLRequest>>,
    delegate: RefCell<Option<Retained<ProtocolObject<dyn WKDownloadDelegate>>>>,
}
define_class!(
    #[unsafe(super(WKDownload))]
    #[name = "QmuxProbeDownload"]
    #[ivars = DownloadState]
    struct ProbeDownload;
    unsafe impl NSObjectProtocol for ProbeDownload {}
    impl ProbeDownload {
        #[unsafe(method_id(originalRequest))]
        fn original_request(&self) -> Option<Retained<NSURLRequest>> { self.ivars().request.clone() }
        #[unsafe(method(setDelegate:))]
        fn set_delegate(&self, delegate: Option<&ProtocolObject<dyn WKDownloadDelegate>>) {
            *self.ivars().delegate.borrow_mut() = delegate.map(|value| value.retain());
        }
    }
);
impl ProbeDownload {
    fn new(mtm: MainThreadMarker, request: Option<Retained<NSURLRequest>>) -> Retained<Self> {
        let download = mtm.alloc::<Self>().set_ivars(DownloadState {
            request,
            delegate: RefCell::new(None),
        });
        unsafe { msg_send![super(download), init] }
    }
}

fn main() {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 300.0));
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            mtm.alloc(),
            rect,
            NSWindowStyleMask::Borderless,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    let content = window.contentView().unwrap();
    let raw = AppKitWindowHandle::new(NonNull::from(&*content).cast());
    let handle = unsafe { WindowHandle::borrow_raw(raw.into()) };
    let selected = std::env::args().nth(1);
    assert!(
        selected
            .as_deref()
            .is_none_or(|name| ["url", "title", "navigation", "eval", "streams"].contains(&name)),
        "unknown native browser test group"
    );
    for (name, test) in [
        ("url", test_empty_url as fn(&WindowHandle<'_>)),
        ("title", test_empty_title),
        ("navigation", test_empty_navigation),
        ("eval", test_eval_results),
        ("streams", native_browser_streams::test_streams),
    ] {
        if selected.as_deref().is_none_or(|selected| selected == name) {
            test(&handle);
        }
    }
    if selected.is_some() {
        return;
    }
    let configuration = unsafe { WKWebViewConfiguration::new(mtm) };
    let features = unsafe { WKWindowFeatures::new(mtm) };
    let action = ProbeAction::new(
        mtm,
        NSURLRequest::requestWithURL(
            &NSURL::URLWithString(&NSString::from_str("https://example.com/popup")).unwrap(),
        ),
    );
    let missing_url = ProbeAction::new(mtm, NSURLRequest::new());
    for mode in ["deny", "allow", "create"] {
        let calls = Rc::new(Cell::new(0));
        let callback_calls = calls.clone();
        let created =
            unsafe { WKWebView::initWithFrame_configuration(mtm.alloc(), rect, &configuration) };
        let expected = created.clone();
        let completed = Rc::new(Cell::new(0));
        let completion_calls = completed.clone();
        let browser = WebViewBuilder::new()
            .with_incognito(true)
            .with_download_started_handler(|_, _| false)
            .with_download_completed_handler(move |_, _, _| {
                completion_calls.set(completion_calls.get() + 1)
            })
            .with_new_window_req_handler(move |url, _| {
                callback_calls.set(callback_calls.get() + 1);
                assert_eq!(url, "https://example.com/popup");
                match mode {
                    "allow" => NewWindowResponse::Allow,
                    "create" => NewWindowResponse::Create {
                        webview: created.clone(),
                    },
                    _ => NewWindowResponse::Deny,
                }
            })
            .build_as_child(&handle)
            .unwrap();
        let native = browser.webview();
        assert!(native.window().is_some());
        native.removeFromSuperview();
        assert!(native.window().is_none());
        let delegate = unsafe { native.UIDelegate().unwrap() };
        let result = unsafe {
            delegate.webView_createWebViewWithConfiguration_forNavigationAction_windowFeatures(
                &native,
                &configuration,
                &action,
                &features,
            )
        };
        assert_eq!(calls.get(), 1);
        assert_eq!(result.is_some(), mode == "create");
        if let Some(result) = result {
            assert_eq!(Retained::as_ptr(&result), Retained::as_ptr(&expected));
        }
        let result = unsafe {
            delegate.webView_createWebViewWithConfiguration_forNavigationAction_windowFeatures(
                &native,
                &configuration,
                &missing_url,
                &features,
            )
        };
        assert!(result.is_none());
        assert_eq!(calls.get(), 1);
        println!("PASS: detached popup {mode}; missing URL rejected");
        let navigation = unsafe { native.navigationDelegate().unwrap() };
        let decisions = Rc::new(Cell::new(0));
        let decision_calls = decisions.clone();
        let decision = block2::RcBlock::new(move |policy| {
            assert_eq!(policy, WKNavigationActionPolicy::Cancel);
            decision_calls.set(decision_calls.get() + 1);
        });
        unsafe {
            navigation.webView_decidePolicyForNavigationAction_decisionHandler(
                &native,
                &missing_url,
                &decision,
            );
        }
        assert_eq!(decisions.get(), 1);
        println!("PASS: navigation with no URL is cancelled exactly once");

        for request in [
            None,
            Some(NSURLRequest::new()),
            Some(action.ivars().clone()),
        ] {
            let has_url = request.as_ref().and_then(|request| request.URL()).is_some();
            let download = ProbeDownload::new(mtm, request);
            unsafe {
                navigation.webView_navigationAction_didBecomeDownload(&native, &action, &download);
            }
            let delegate = download.ivars().delegate.borrow().as_ref().unwrap().clone();
            let destinations = Rc::new(Cell::new(0));
            let destination_calls = destinations.clone();
            let destination = block2::RcBlock::new(move |url: *mut NSURL| {
                assert!(url.is_null());
                destination_calls.set(destination_calls.get() + 1);
            });
            unsafe {
                delegate
                    .download_decideDestinationUsingResponse_suggestedFilename_completionHandler(
                        &download,
                        &NSURLResponse::new(),
                        &NSString::from_str("test.txt"),
                        &destination,
                    );
            }
            assert_eq!(destinations.get(), 1);
            let previous = completed.get();
            unsafe {
                delegate.downloadDidFinish(&download);
                delegate.download_didFailWithError_resumeData(
                    &download,
                    &NSError::errorWithDomain_code_userInfo(
                        &NSString::from_str("QmuxTest"),
                        1,
                        None,
                    ),
                    None::<&NSData>,
                );
            }
            assert_eq!(completed.get() - previous, if has_url { 2 } else { 0 });
            // WebKit alone can initialize WKDownload's internal C++ object.
            // This selector-only fixture must not run its superclass dealloc;
            // the short-lived test process reclaims it on exit.
            std::mem::forget(download);
        }
        println!(
            "PASS: download callbacks handle missing requests, missing URLs, and nil resume data"
        );
    }
}
