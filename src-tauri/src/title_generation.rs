#[cfg(all(target_os = "macos", qmux_foundation_models))]
mod foundation_models {
    use serde::Deserialize;
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;

    unsafe extern "C" {
        fn qmux_generate_foundation_title(message: *const c_char) -> *mut c_char;
        fn qmux_free_foundation_title(message: *mut c_char);
    }

    #[derive(Deserialize)]
    struct TitleResponse {
        title: Option<String>,
        error: Option<String>,
    }

    pub fn generate(message: &str) -> Result<String, String> {
        let message = CString::new(message)
            .map_err(|_| "message contains an interior NUL byte".to_string())?;
        let response = unsafe { qmux_generate_foundation_title(message.as_ptr()) };
        if response.is_null() {
            return Err("Apple Foundation Models returned no response".to_string());
        }

        let raw = unsafe { CStr::from_ptr(response).to_string_lossy().into_owned() };
        unsafe { qmux_free_foundation_title(response) };

        let response: TitleResponse = serde_json::from_str(&raw)
            .map_err(|err| format!("Apple Foundation Models returned invalid JSON: {err}"))?;
        if let Some(error) = response.error.filter(|error| !error.trim().is_empty()) {
            return Err(error);
        }
        response
            .title
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty())
            .ok_or_else(|| "Apple Foundation Models returned no title".to_string())
    }
}

#[cfg(all(target_os = "macos", qmux_foundation_models))]
pub fn generate_foundation_title(message: &str) -> Result<String, String> {
    foundation_models::generate(message)
}

#[cfg(not(all(target_os = "macos", qmux_foundation_models)))]
pub fn generate_foundation_title(_message: &str) -> Result<String, String> {
    Err("Apple Foundation Models are not available in this build".to_string())
}

pub fn foundation_models_available() -> bool {
    cfg!(all(target_os = "macos", qmux_foundation_models))
}
