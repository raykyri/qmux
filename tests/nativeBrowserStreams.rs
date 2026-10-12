// Exercised by the native browser runner on the main AppKit thread.
use objc2::{
    define_class, msg_send, rc::Retained, runtime::ProtocolObject, AllocAnyThread, DefinedClass,
};
use objc2_foundation::{
    ns_string, NSData, NSError, NSInputStream, NSMutableURLRequest, NSObject, NSObjectProtocol,
    NSURLRequest, NSURLResponse, NSURL,
};
use objc2_web_kit::{WKURLSchemeHandler, WKURLSchemeTask};
use raw_window_handle::WindowHandle;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
use wry::{WebViewBuilder, WebViewExtMacOS};

#[derive(Clone, Copy, Debug)]
enum ReadBehavior {
    ErrorAfterData,
    Error,
    ErrorWithoutDetails,
    Empty,
    Data,
}

struct StreamState {
    behavior: ReadBehavior,
    reads: Cell<usize>,
    closes: Cell<usize>,
}

define_class!(
    #[unsafe(super(NSInputStream))]
    #[name = "QmuxProbeBodyStream"]
    #[ivars = StreamState]
    struct ProbeStream;
    unsafe impl NSObjectProtocol for ProbeStream {}
    impl ProbeStream {
        #[unsafe(method(open))]
        fn open(&self) {}
        #[unsafe(method(close))]
        fn close(&self) { self.ivars().closes.set(self.ivars().closes.get() + 1); }
        #[unsafe(method(hasBytesAvailable))]
        fn has_bytes(&self) -> bool { self.ivars().reads.get() < 3 }
        #[unsafe(method(read:maxLength:))]
        unsafe fn read(&self, buffer: *mut u8, length: usize) -> isize {
            assert!(length >= 3);
            let reads = self.ivars().reads.get();
            self.ivars().reads.set(reads + 1);
            match (self.ivars().behavior, reads) {
                (ReadBehavior::Error | ReadBehavior::ErrorWithoutDetails, _)
                | (ReadBehavior::ErrorAfterData, 1..) => -1,
                (ReadBehavior::Empty, _) | (ReadBehavior::Data, 2..) => 0,
                _ => { buffer.copy_from_nonoverlapping(b"abc".as_ptr(), 3); 3 }
            }
        }
        #[unsafe(method_id(streamError))]
        fn error(&self) -> Option<Retained<NSError>> {
            if matches!(self.ivars().behavior, ReadBehavior::ErrorWithoutDetails) {
                None
            } else {
                Some(unsafe { NSError::errorWithDomain_code_userInfo(ns_string!("QmuxProbeStream"), 17, None) })
            }
        }
    }
);

impl ProbeStream {
    fn new(behavior: ReadBehavior) -> Retained<Self> {
        let stream = Self::alloc().set_ivars(StreamState {
            behavior,
            reads: Cell::new(0),
            closes: Cell::new(0),
        });
        unsafe { msg_send![super(stream), init] }
    }
}

struct TaskState {
    request: Retained<NSURLRequest>,
    errors: RefCell<Vec<isize>>,
    finishes: Cell<usize>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "QmuxProbeStreamTask"]
    #[ivars = TaskState]
    struct ProbeTask;
    unsafe impl NSObjectProtocol for ProbeTask {}
    unsafe impl WKURLSchemeTask for ProbeTask {
        #[unsafe(method_id(request))]
        fn request(&self) -> Retained<NSURLRequest> {
            self.ivars().request.clone()
        }
        #[unsafe(method(didReceiveResponse:))]
        fn response(&self, _response: &NSURLResponse) {}
        #[unsafe(method(didReceiveData:))]
        fn data(&self, _data: &NSData) {}
        #[unsafe(method(didFinish))]
        fn finish(&self) {
            self.ivars().finishes.set(self.ivars().finishes.get() + 1);
        }
        #[unsafe(method(didFailWithError:))]
        fn fail(&self, error: &NSError) {
            self.ivars().errors.borrow_mut().push(error.code());
        }
    }
);

pub fn test_streams(handle: &WindowHandle<'_>) {
    for behavior in [
        ReadBehavior::ErrorAfterData,
        ReadBehavior::Error,
        ReadBehavior::ErrorWithoutDetails,
        ReadBehavior::Empty,
        ReadBehavior::Data,
    ] {
        let bodies = Rc::new(RefCell::new(Vec::new()));
        let received_bodies = bodies.clone();
        let browser = WebViewBuilder::new()
            .with_incognito(true)
            .with_custom_protocol("qmux-stream-probe".into(), move |_, request| {
                received_bodies.borrow_mut().push(request.body().clone());
                wry::http::Response::new(Vec::new().into())
            })
            .build_as_child(handle)
            .unwrap();
        let native = browser.webview();
        let scheme = unsafe {
            native
                .configuration()
                .urlSchemeHandlerForURLScheme(ns_string!("qmux-stream-probe"))
                .unwrap()
        };
        let stream = ProbeStream::new(behavior);
        let url = NSURL::URLWithString(ns_string!("qmux-stream-probe://localhost/body")).unwrap();
        let request = NSMutableURLRequest::requestWithURL(&url);
        request.setHTTPMethod(ns_string!("POST"));
        request.setHTTPBodyStream(Some(&stream));
        let task = ProbeTask::alloc().set_ivars(TaskState {
            request: request.into_super(),
            errors: RefCell::new(Vec::new()),
            finishes: Cell::new(0),
        });
        let task: Retained<ProbeTask> = unsafe { msg_send![super(task), init] };
        unsafe {
            scheme.webView_startURLSchemeTask(&native, ProtocolObject::from_ref(&*task));
        }
        assert_eq!(
            stream.ivars().closes.get(),
            1,
            "stream not closed: {behavior:?}"
        );
        match behavior {
            ReadBehavior::ErrorAfterData
            | ReadBehavior::Error
            | ReadBehavior::ErrorWithoutDetails => {
                assert!(
                    bodies.borrow().is_empty(),
                    "error forwarded an invalid or partial body"
                );
                let expected_error = if matches!(behavior, ReadBehavior::ErrorWithoutDetails) {
                    1
                } else {
                    17
                };
                assert_eq!(&*task.ivars().errors.borrow(), &[expected_error]);
                assert_eq!(task.ivars().finishes.get(), 0);
            }
            ReadBehavior::Empty | ReadBehavior::Data => {
                let expected: &[u8] = if matches!(behavior, ReadBehavior::Empty) {
                    b""
                } else {
                    b"abcabc"
                };
                assert_eq!(&*bodies.borrow(), &[expected]);
                assert!(task.ivars().errors.borrow().is_empty());
                assert_eq!(task.ivars().finishes.get(), 1);
                assert_eq!(
                    stream.ivars().reads.get(),
                    if expected.is_empty() { 1 } else { 3 }
                );
            }
        }
        println!("PASS: custom protocol stream {behavior:?}");
    }
}
