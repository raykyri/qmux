// Copyright 2020-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
  borrow::Cow,
  ffi::{c_char, c_void, CStr},
  io::Write,
  panic::AssertUnwindSafe,
  ptr::NonNull,
};

use http::{
  header::{CONTENT_LENGTH, CONTENT_TYPE},
  Request, Response as HttpResponse,
};
use objc2::{
  rc::Retained,
  runtime::{AnyClass, AnyObject, ClassBuilder, ProtocolObject},
  AllocAnyThread, ClassType, Message,
};
use objc2_foundation::{
  NSData, NSError, NSHTTPURLResponse, NSMutableDictionary, NSObject, NSObjectProtocol, NSString,
  NSURL, NSUUID,
};
use objc2_web_kit::{WKURLSchemeHandler, WKURLSchemeTask};

use crate::{wkwebview::WEBVIEW_STATE, RequestAsyncResponder, WryWebView};

fn report_ffi_panic(message: &'static [u8]) {
  // `eprintln!` itself panics on a write failure. Keep even diagnostics inside
  // an unwind guard so this Objective-C boundary remains fail-closed.
  let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
    let _ = std::io::stderr().write_all(message);
  }));
}

fn check_webview_id_valid(webview_id: &str) -> crate::Result<()> {
  if !WEBVIEW_STATE
    .read()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .contains_key(webview_id)
  {
    return Err(crate::Error::CustomProtocolTaskInvalid);
  }
  Ok(())
}

unsafe fn protocol_error(code: isize) -> Retained<NSError> {
  NSError::errorWithDomain_code_userInfo(&NSString::from_str("wry.custom-protocol"), code, None)
}

unsafe fn fail_task(
  webview: &WryWebView,
  task: &ProtocolObject<dyn WKURLSchemeTask>,
  task_key: usize,
  task_uuid: &NSUUID,
  error: &NSError,
) {
  // Remove the exact active task before calling back into WebKit. A handler
  // may already have completed, cancelled, or replaced it before failing.
  if webview.remove_custom_task_key_if_current(task_key, task_uuid) {
    let _ = objc2::exception::catch(AssertUnwindSafe(|| {
      task.didFailWithError(error);
    }));
  }
}

pub fn create(name: &str) -> &AnyClass {
  unsafe {
    // Include the address of WEBVIEW_STATE in the class name so that each dylib in the process
    // gets its own ObjC class with method pointers into its own code and data segments.
    let unique_id = std::ptr::addr_of!(WEBVIEW_STATE) as usize;
    let scheme_name = format!("{name}URLSchemeHandler_{unique_id:x}\0");
    let scheme_name = CStr::from_bytes_with_nul(scheme_name.as_bytes()).unwrap();
    let cls = ClassBuilder::new(scheme_name, NSObject::class());
    match cls {
      Some(mut cls) => {
        cls.add_ivar::<*mut c_char>(c"webview_id");
        cls.add_ivar::<usize>(c"protocol_index");
        cls.add_method(
          objc2::sel!(webView:startURLSchemeTask:),
          start_task as extern "C" fn(_, _, _, _),
        );
        cls.add_method(
          objc2::sel!(webView:stopURLSchemeTask:),
          stop_task as extern "C" fn(_, _, _, _),
        );
        cls.register()
      }
      None => AnyClass::get(scheme_name).expect("Failed to get the class definition"),
    }
  }
}

// Task handler for custom protocol
extern "C" fn start_task(
  this: &AnyObject,
  _sel: objc2::runtime::Sel,
  webview: &WryWebView,
  task: &ProtocolObject<dyn WKURLSchemeTask>,
) {
  // No Rust panic may cross an Objective-C method implementation. Rust turns
  // an unwind through this `extern "C"` boundary into `panic_cannot_unwind`,
  // aborting the entire host application.
  let mut task_identity = None;
  let mut cleanup_webview_id = None;
  if std::panic::catch_unwind(AssertUnwindSafe(|| {
    let task_key = task.hash();
    let task_uuid = webview.add_custom_task_key(task_key);
    task_identity = Some((task_key, task_uuid.clone()));
    start_task_inner(
      this,
      webview,
      task,
      task_key,
      task_uuid,
      &mut cleanup_webview_id,
    );
  }))
  .is_err()
  {
    // Cleanup must also stay behind the FFI unwind boundary.
    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| unsafe {
      if let Some((task_key, task_uuid)) = task_identity {
        if cleanup_webview_id
          .as_deref()
          .is_some_and(|id| check_webview_id_valid(id).is_err())
        {
          webview.remove_custom_task_key_if_current(task_key, &task_uuid);
        } else {
          fail_task(webview, task, task_key, &task_uuid, &protocol_error(3));
        }
      }
    }));
    report_ffi_panic(b"wry: custom URL-scheme handler panicked; failing any active request\n");
  }
}

fn start_task_inner(
  this: &AnyObject,
  webview: &WryWebView,
  task: &ProtocolObject<dyn WKURLSchemeTask>,
  task_key: usize,
  task_uuid: Retained<NSUUID>,
  cleanup_webview_id: &mut Option<String>,
) {
  unsafe {
    #[cfg(feature = "tracing")]
    let span = tracing::info_span!(parent: None, "wry::custom_protocol::handle", uri = tracing::field::Empty)
      .entered();

    let ivar = this.class().instance_variable(c"webview_id").unwrap();
    let webview_id_ptr: *mut c_char = *ivar.load(this);
    let webview_id = CStr::from_ptr(webview_id_ptr)
      .to_str()
      .ok()
      .unwrap_or_default();
    // The application handler may dispose the view before panicking. Keep an
    // owned identity available to its unwind cleanup, independent of the
    // Objective-C handler's borrowed identifier storage.
    *cleanup_webview_id = Some(webview_id.to_string());

    let ivar = this.class().instance_variable(c"protocol_index").unwrap();
    let protocol_index: usize = *ivar.load(this);

    let function = WEBVIEW_STATE
      .read()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .get(webview_id)
      .and_then(|v| v.protocol_ptrs.get(protocol_index))
      .cloned();

    if let Some(function) = function {
      // Get url request
      let request = task.request();
      let Some(url) = request.URL() else {
        fail_task(webview, task, task_key, &task_uuid, &protocol_error(2));
        return;
      };
      let Some(uri) = url.absoluteString() else {
        fail_task(webview, task, task_key, &task_uuid, &protocol_error(2));
        return;
      };
      let uri = uri.to_string();

      #[cfg(feature = "tracing")]
      span.record("uri", uri.clone());

      // Get request method (GET, POST, PUT etc...)
      let Some(method) = request.HTTPMethod() else {
        fail_task(webview, task, task_key, &task_uuid, &protocol_error(2));
        return;
      };
      let method = method.to_string();

      // Prepare our HttpRequest
      let mut http_request = Request::builder().uri(uri).method(method.as_str());

      // Get body
      let mut sent_form_body = Vec::new();
      let body = request.HTTPBody();
      let body_stream = request.HTTPBodyStream();
      if let Some(body) = body {
        sent_form_body = body.to_vec();
      } else if let Some(body_stream) = body_stream {
        body_stream.open();
        let mut buffer = [0u8; 4096];
        let stream_error = loop {
          // NSInputStream returns a signed count: zero is EOF and -1 is an
          // error. Never turn that result into an unchecked Vec length.
          let count = body_stream.read_maxLength(NonNull::from(&mut buffer).cast(), buffer.len());
          if count < 0 {
            break Some(
              body_stream
                .streamError()
                .unwrap_or_else(|| protocol_error(1)),
            );
          }
          if count == 0 {
            break None;
          }
          sent_form_body.extend_from_slice(&buffer[..count as usize]);
        };
        body_stream.close();
        if let Some(error) = stream_error {
          // Do not dispatch an incomplete body to the application. Complete
          // the WebKit task even if a failed stream did not provide an error.
          fail_task(webview, task, task_key, &task_uuid, &error);
          return;
        }
      }

      // Extract all headers fields
      let all_headers = request.allHTTPHeaderFields();

      // get all our headers values and inject them in our request
      if let Some(all_headers) = all_headers {
        for current_header in all_headers.allKeys().iter() {
          let header_value = all_headers.valueForKey(&current_header).unwrap();
          // inject the header into the request
          http_request = http_request.header(current_header.to_string(), header_value.to_string());
        }
      }

      /// Task may not live longer than async custom protocol handler.
      ///
      /// There are roughly 2 ways to cause segfault:
      /// 1. Task has stopped. pointer of the task not valid anymore.
      /// 2. Task had stopped, but the pointer of the task has allocated to a new task.
      ///    Outdated custom handler may call to the new task instance and cause segfault.
      fn check_task_is_valid(
        webview: &WryWebView,
        task_key: usize,
        current_uuid: Retained<NSUUID>,
      ) -> crate::Result<()> {
        let latest_task_uuid = webview.get_custom_task_uuid(task_key);
        let Some(latest_uuid) = latest_task_uuid else {
          return Err(crate::Error::CustomProtocolTaskInvalid);
        };
        if latest_uuid != current_uuid {
          return Err(crate::Error::CustomProtocolTaskInvalid);
        }
        Ok(())
      }

      // send response
      match http_request.body(sent_form_body) {
        Ok(final_request) => {
          let webview = webview.retain();
          let task = task.retain();
          let responder: Box<dyn FnOnce(HttpResponse<Cow<'static, [u8]>>)> =
            Box::new(move |sent_response| {
              // Consolidate checks before calling into `did*` methods.
              let validate = || -> crate::Result<()> {
                check_webview_id_valid(webview_id)?;
                check_task_is_valid(&webview, task_key, task_uuid.clone())?;
                Ok(())
              };

              // Perform an upfront validation
              if let Err(_e) = validate() {
                #[cfg(feature = "tracing")]
                tracing::warn!("Task invalid before sending response: {:?}", _e);
                return; // If invalid, return early without calling task methods.
              }

              unsafe fn response(
                // FIXME: though we give it a static lifetime, it's not guaranteed to be valid.
                task: Retained<ProtocolObject<dyn WKURLSchemeTask>>,
                // FIXME: though we give it a static lifetime, it's not guaranteed to be valid.
                webview: Retained<WryWebView>,
                task_key: usize,
                task_uuid: Retained<NSUUID>,
                webview_id: &str,
                url: Retained<NSURL>,
                sent_response: HttpResponse<Cow<'_, [u8]>>,
              ) -> crate::Result<()> {
                // Validate
                check_webview_id_valid(webview_id)?;
                check_task_is_valid(&webview, task_key, task_uuid.clone())?;

                let content = sent_response.body();
                // default: application/octet-stream, but should be provided by the client
                let wanted_mime = sent_response.headers().get(CONTENT_TYPE);
                // default to 200
                let wanted_status_code = sent_response.status().as_u16() as i32;
                // default to HTTP/1.1
                let wanted_version = format!("{:#?}", sent_response.version());

                let headers = NSMutableDictionary::new();
                if let Some(mime) = wanted_mime {
                  let mime = mime
                    .to_str()
                    .map_err(|_| crate::Error::CustomProtocolTaskInvalid)?;
                  headers.insert(
                    &*NSString::from_str(CONTENT_TYPE.as_str()),
                    &*NSString::from_str(mime),
                  );
                }
                headers.insert(
                  &*NSString::from_str(CONTENT_LENGTH.as_str()),
                  &*NSString::from_str(&content.len().to_string()),
                );

                // add headers
                for (name, value) in sent_response.headers().iter() {
                  if let Ok(value) = value.to_str() {
                    headers.insert(
                      &*NSString::from_str(name.as_str()),
                      &*NSString::from_str(value),
                    );
                  }
                }

                let urlresponse = NSHTTPURLResponse::alloc();
                let response = NSHTTPURLResponse::initWithURL_statusCode_HTTPVersion_headerFields(
                  urlresponse,
                  &url,
                  wanted_status_code as isize,
                  Some(&NSString::from_str(&wanted_version)),
                  Some(&headers),
                )
                .ok_or(crate::Error::CustomProtocolTaskInvalid)?;

                // Re-validate before calling didReceiveResponse
                check_webview_id_valid(webview_id)?;
                check_task_is_valid(&webview, task_key, task_uuid.clone())?;

                // Use map_err to convert Option<Retained<Exception>> to crate::Error
                objc2::exception::catch(AssertUnwindSafe(|| {
                  task.didReceiveResponse(&response);
                }))
                .map_err(|_e| crate::Error::CustomProtocolTaskInvalid)?;

                // Send data
                let data = NSData::alloc();
                // MIGRATE NOTE: we copied the content to the NSData because content will be freed
                // when out of scope but NSData will also free the content when it's done and cause doube free.
                let data = NSData::initWithBytes_length(
                  data,
                  content.as_ptr() as *mut c_void,
                  content.len(),
                );

                // Check validity again
                check_webview_id_valid(webview_id)?;
                check_task_is_valid(&webview, task_key, task_uuid.clone())?;

                objc2::exception::catch(AssertUnwindSafe(|| {
                  task.didReceiveData(&data);
                }))
                .map_err(|_e| crate::Error::CustomProtocolTaskInvalid)?;

                check_webview_id_valid(webview_id)?;
                // Retire before the terminal callback: didFinish can reenter
                // startURLSchemeTask and install a replacement at this key.
                // Its completion must not delete that newer registration.
                if !webview.remove_custom_task_key_if_current(task_key, &task_uuid) {
                  return Err(crate::Error::CustomProtocolTaskInvalid);
                }

                objc2::exception::catch(AssertUnwindSafe(|| {
                  task.didFinish();
                }))
                .map_err(|_e| crate::Error::CustomProtocolTaskInvalid)?;

                Ok(())
              }

              #[cfg(feature = "tracing")]
              let _span = tracing::info_span!("wry::custom_protocol::call_handler").entered();

              // Async responders execute after start_task's unwind guard has
              // returned. Keep their errors and panics local, and finish only
              // the exact task that is still active after any native callback.
              let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                response(
                  task.clone(),
                  webview.clone(),
                  task_key,
                  task_uuid.clone(),
                  webview_id,
                  url,
                  sent_response,
                )
              }));
              if !matches!(result, Ok(Ok(()))) {
                let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
                  if check_webview_id_valid(webview_id).is_ok() {
                    fail_task(&webview, &task, task_key, &task_uuid, &protocol_error(5));
                  } else {
                    // didReceiveResponse/Data may synchronously dispose the
                    // view. Match upfront validation: retire our registration
                    // without calling into a task owned by the disposed view.
                    webview.remove_custom_task_key_if_current(task_key, &task_uuid);
                  }
                }));
                #[cfg(feature = "tracing")]
                tracing::error!("Error responding to custom protocol task");
              }
            });

          #[cfg(feature = "tracing")]
          let _span = tracing::info_span!("wry::custom_protocol::call_handler").entered();

          function(
            webview_id,
            final_request,
            RequestAsyncResponder { responder },
          );
        }
        Err(_) => fail_task(webview, task, task_key, &task_uuid, &protocol_error(2)),
      };
    } else {
      fail_task(webview, task, task_key, &task_uuid, &protocol_error(4));
      #[cfg(feature = "tracing")]
      tracing::warn!(
        "Either WebView or WebContext instance is dropped! This handler shouldn't be called."
      );
    };
  }
}

extern "C" fn stop_task(
  _this: &ProtocolObject<dyn WKURLSchemeHandler>,
  _sel: objc2::runtime::Sel,
  webview: &WryWebView,
  task: &ProtocolObject<dyn WKURLSchemeTask>,
) {
  if std::panic::catch_unwind(AssertUnwindSafe(|| {
    webview.remove_custom_task_key(task.hash());
  }))
  .is_err()
  {
    report_ffi_panic(b"wry: custom URL-scheme stop handler panicked; dropping the request\n");
  }
}
