// Custom-protocol terminal callbacks, exercised by the native AppKit runner.
use objc2::{
    define_class, msg_send, rc::Retained, runtime::ProtocolObject, AllocAnyThread, DefinedClass,
};
use objc2_foundation::{
    ns_string, NSData, NSError, NSObject, NSObjectProtocol, NSString, NSURLRequest, NSURLResponse,
    NSURL,
};
use objc2_web_kit::{WKURLSchemeHandler, WKURLSchemeTask};
use raw_window_handle::WindowHandle;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
use wry::{WebViewBuilder, WebViewExtMacOS};

struct RequestState {
    url: Option<Retained<NSURL>>,
    method: Option<Retained<NSString>>,
}

define_class!(
    #[unsafe(super(NSURLRequest))]
    #[name = "QmuxProbeProtocolRequest"]
    #[ivars = RequestState]
    struct ProbeRequest;
    unsafe impl NSObjectProtocol for ProbeRequest {}
    impl ProbeRequest {
        #[unsafe(method_id(URL))]
        fn url(&self) -> Option<Retained<NSURL>> { self.ivars().url.clone() }
        #[unsafe(method_id(HTTPMethod))]
        fn method(&self) -> Option<Retained<NSString>> { self.ivars().method.clone() }
    }
);

struct TaskState {
    mode: &'static str,
    request: Retained<NSURLRequest>,
    failures: RefCell<Vec<isize>>,
    responses: Cell<usize>,
    data_callbacks: Cell<usize>,
    finishes: Cell<usize>,
    response_action: RefCell<Option<Box<dyn Fn()>>>,
    data_action: RefCell<Option<Box<dyn Fn()>>>,
    finish_action: RefCell<Option<Box<dyn Fn()>>>,
    failure_action: RefCell<Option<Box<dyn Fn()>>>,
}

fn throw_fixture_exception() -> ! {
    let exception = unsafe {
        msg_send![objc2::runtime::AnyClass::get(c"NSException").unwrap(),
            exceptionWithName: ns_string!("QmuxProtocolProbe"),
            reason: ns_string!("Expected callback exception"),
            userInfo: std::ptr::null::<NSObject>()]
    };
    objc2::exception::throw(exception)
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "QmuxProbeProtocolTask"]
    #[ivars = TaskState]
    struct ProbeTask;
    unsafe impl NSObjectProtocol for ProbeTask {}
    unsafe impl WKURLSchemeTask for ProbeTask {
        #[unsafe(method_id(request))]
        fn request(&self) -> Retained<NSURLRequest> {
            self.ivars().request.clone()
        }
        #[unsafe(method(didReceiveResponse:))]
        fn response(&self, _response: &NSURLResponse) {
            self.ivars().responses.set(self.ivars().responses.get() + 1);
            let action = self.ivars().response_action.borrow_mut().take();
            if let Some(action) = action {
                action();
            }
            if self.ivars().mode == "throw_at_response" {
                throw_fixture_exception();
            }
        }
        #[unsafe(method(didReceiveData:))]
        fn data(&self, _data: &NSData) {
            self.ivars()
                .data_callbacks
                .set(self.ivars().data_callbacks.get() + 1);
            let action = self.ivars().data_action.borrow_mut().take();
            if let Some(action) = action {
                action();
            }
            if self.ivars().mode == "throw_at_data" {
                throw_fixture_exception();
            }
        }
        #[unsafe(method(didFinish))]
        fn finish(&self) {
            self.ivars().finishes.set(self.ivars().finishes.get() + 1);
            let action = self.ivars().finish_action.borrow_mut().take();
            if let Some(action) = action {
                action();
            }
            if self.ivars().mode == "throw_at_finish" {
                throw_fixture_exception();
            }
        }
        #[unsafe(method(didFailWithError:))]
        fn fail(&self, error: &NSError) {
            self.ivars().failures.borrow_mut().push(error.code());
            let action = self.ivars().failure_action.borrow_mut().take();
            if let Some(action) = action {
                action();
            }
            if self.ivars().mode == "throw_at_failure" {
                throw_fixture_exception();
            }
        }
    }
);

pub fn test_protocols(handle: &WindowHandle<'_>) {
    for mode in [
        "missing_url",
        "missing_method",
        "invalid_method",
        "removed_handler",
        "panic",
        "panic_after_success",
        "panic_after_cancel",
        "late_response",
        "replaced_task",
        "replace_at_finish",
        "async_invalid_mime",
        "cancel_at_response",
        "throw_at_response",
        "throw_at_finish",
        "cancel_at_data",
        "replace_at_data",
        "throw_at_data",
        "throw_at_failure",
        "replace_at_failure",
        "dispose_before_response",
        "dispose_at_response",
        "dispose_at_data",
        "panic_after_dispose",
    ] {
        let calls = Rc::new(Cell::new(0));
        let handler_calls = calls.clone();
        let saved = Rc::new(RefCell::new(None));
        let pending = saved.clone();
        let control: Rc<RefCell<Option<Box<dyn Fn()>>>> = Rc::new(RefCell::new(None));
        let handler_control = control.clone();
        let browser = WebViewBuilder::new()
            .with_incognito(true)
            .with_asynchronous_custom_protocol(
                "qmux-protocol-probe".into(),
                move |_, _, responder| {
                    handler_calls.set(handler_calls.get() + 1);
                    if matches!(mode, "replaced_task" | "replace_at_failure")
                        && handler_calls.get() == 2
                    {
                        *pending.borrow_mut() = Some(responder);
                        return;
                    }
                    match mode {
                        "async_invalid_mime"
                        | "replace_at_finish"
                        | "cancel_at_response"
                        | "throw_at_response"
                        | "throw_at_finish"
                        | "cancel_at_data"
                        | "replace_at_data"
                        | "throw_at_data"
                        | "dispose_before_response"
                        | "dispose_at_response"
                        | "dispose_at_data" => {
                            *pending.borrow_mut() = Some(responder);
                            return;
                        }
                        "panic_after_success" => {
                            responder.respond(wry::http::Response::new(Vec::new()))
                        }
                        "panic_after_cancel" | "replaced_task" | "panic_after_dispose" => {
                            handler_control.borrow().as_ref().unwrap()()
                        }
                        "late_response" => *pending.borrow_mut() = Some(responder),
                        _ => {}
                    }
                    panic!("expected protocol fixture panic: {mode}");
                },
            )
            .build_as_child(handle)
            .unwrap();
        let native = browser.webview();
        let scheme = unsafe {
            native
                .configuration()
                .urlSchemeHandlerForURLScheme(ns_string!("qmux-protocol-probe"))
                .unwrap()
        };
        let browser = Rc::new(RefCell::new(Some(browser)));
        let request = ProbeRequest::alloc().set_ivars(RequestState {
            url: (mode != "missing_url").then(|| {
                NSURL::URLWithString(ns_string!("qmux-protocol-probe://localhost/request")).unwrap()
            }),
            method: (mode != "missing_method").then(|| {
                NSString::from_str(if mode == "invalid_method" {
                    "invalid method"
                } else {
                    "GET"
                })
            }),
        });
        let request: Retained<ProbeRequest> = unsafe { msg_send![super(request), init] };
        let task = ProbeTask::alloc().set_ivars(TaskState {
            mode,
            request: request.into_super(),
            failures: RefCell::new(Vec::new()),
            responses: Cell::new(0),
            data_callbacks: Cell::new(0),
            finishes: Cell::new(0),
            response_action: RefCell::new(None),
            data_action: RefCell::new(None),
            finish_action: RefCell::new(None),
            failure_action: RefCell::new(None),
        });
        let task: Retained<ProbeTask> = unsafe { msg_send![super(task), init] };
        let action_scheme = scheme.clone();
        let action_native = native.clone();
        let action_task = task.clone();
        *control.borrow_mut() = Some(Box::new(move || unsafe {
            if matches!(
                mode,
                "replaced_task" | "replace_at_finish" | "replace_at_data" | "replace_at_failure"
            ) {
                action_scheme.webView_startURLSchemeTask(
                    &action_native,
                    ProtocolObject::from_ref(&*action_task),
                );
            } else {
                action_scheme.webView_stopURLSchemeTask(
                    &action_native,
                    ProtocolObject::from_ref(&*action_task),
                );
            }
        }));
        if mode == "panic_after_dispose" {
            let disposed_browser = browser.clone();
            *control.borrow_mut() = Some(Box::new(move || {
                disposed_browser.borrow_mut().take();
            }));
        }
        if mode == "replace_at_finish" {
            let finish_control = control.clone();
            *task.ivars().finish_action.borrow_mut() = Some(Box::new(move || {
                finish_control.borrow().as_ref().unwrap()();
            }));
        }
        if mode == "cancel_at_response" {
            let response_control = control.clone();
            *task.ivars().response_action.borrow_mut() = Some(Box::new(move || {
                response_control.borrow().as_ref().unwrap()();
            }));
        }
        if matches!(mode, "cancel_at_data" | "replace_at_data") {
            let data_control = control.clone();
            *task.ivars().data_action.borrow_mut() = Some(Box::new(move || {
                data_control.borrow().as_ref().unwrap()();
            }));
        }
        if mode == "replace_at_failure" {
            let failure_control = control.clone();
            *task.ivars().failure_action.borrow_mut() = Some(Box::new(move || {
                failure_control.borrow().as_ref().unwrap()();
            }));
        }
        if matches!(mode, "dispose_at_response" | "dispose_at_data") {
            let disposed_browser = browser.clone();
            let action: Box<dyn Fn()> = Box::new(move || {
                disposed_browser.borrow_mut().take();
            });
            if mode == "dispose_at_response" {
                *task.ivars().response_action.borrow_mut() = Some(action);
            } else {
                *task.ivars().data_action.borrow_mut() = Some(action);
            }
        }
        if mode == "removed_handler" {
            browser.borrow_mut().take();
        }
        unsafe {
            scheme.webView_startURLSchemeTask(&native, ProtocolObject::from_ref(&*task));
        }
        if mode == "dispose_before_response" {
            browser.borrow_mut().take();
        }
        if mode == "replaced_task" {
            assert!(
                task.ivars().failures.borrow().is_empty(),
                "old failure cancelled a newer task"
            );
        }
        let responder = saved.borrow_mut().take();
        if let Some(responder) = responder {
            let mut response = wry::http::Response::new(Vec::new());
            if mode == "async_invalid_mime" {
                response.headers_mut().insert(
                    wry::http::header::CONTENT_TYPE,
                    wry::http::HeaderValue::from_bytes(b"text/\xff").unwrap(),
                );
            }
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                responder.respond(response);
            }));
            assert!(outcome.is_ok(), "asynchronous response panicked: {mode}");
        }
        if matches!(mode, "replace_at_finish" | "replace_at_data") {
            let replacement = saved.borrow_mut().take().expect("replacement task missing");
            replacement.respond(wry::http::Response::new(Vec::new()));
        }
        let expected_failures: &[isize] = match mode {
            "missing_url" | "missing_method" | "invalid_method" => &[2],
            "removed_handler" => &[4],
            "panic" | "late_response" | "throw_at_failure" | "replace_at_failure" => &[3],
            "async_invalid_mime" | "throw_at_response" | "throw_at_data" => &[5],
            _ => &[],
        };
        assert_eq!(
            &*task.ivars().failures.borrow(),
            expected_failures,
            "{mode}"
        );
        let (expected_responses, expected_data, expected_finishes) = match mode {
            "replace_at_finish" => (2, 2, 2),
            "replace_at_data" => (2, 2, 1),
            "cancel_at_response" | "throw_at_response" | "dispose_at_response" => (1, 0, 0),
            "cancel_at_data" | "throw_at_data" | "dispose_at_data" => (1, 1, 0),
            "panic_after_success" | "replaced_task" | "throw_at_finish" | "replace_at_failure" => {
                (1, 1, 1)
            }
            _ => (0, 0, 0),
        };
        assert_eq!(task.ivars().responses.get(), expected_responses, "{mode}");
        assert_eq!(task.ivars().data_callbacks.get(), expected_data, "{mode}");
        assert_eq!(task.ivars().finishes.get(), expected_finishes, "{mode}");
        if matches!(mode, "missing_url" | "missing_method" | "invalid_method") {
            assert_eq!(calls.get(), 0);
        }
        // Release references held only to drive synchronous reentrancy.
        control.borrow_mut().take();
        println!("PASS: custom protocol completion {mode}");
    }
}
