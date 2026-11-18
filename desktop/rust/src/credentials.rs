use windows_sys::Win32::Security::Credentials::{
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW,
    CredWriteW,
};

fn target() -> Vec<u16> {
    "com.honeypie3301.gitdigest/github-token\0"
        .encode_utf16()
        .collect()
}

#[tauri::command]
pub fn read_token() -> Result<String, String> {
    let target = target();
    let mut credential = std::ptr::null_mut();
    // Windows allocates the credential; it is freed after copying its blob.
    unsafe {
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error() == Some(1168) {
                Ok(String::new())
            } else {
                Err(error.to_string())
            };
        }
        let data = &*credential;
        let value = if data.CredentialBlobSize == 0 {
            Ok(String::new())
        } else {
            String::from_utf8(
                std::slice::from_raw_parts(data.CredentialBlob, data.CredentialBlobSize as usize)
                    .to_vec(),
            )
            .map_err(|_| "The saved token could not be decoded.".to_string())
        };
        CredFree(credential.cast());
        value
    }
}

#[tauri::command]
pub fn save_token(token: String) -> Result<(), String> {
    let mut target = target();
    if token.is_empty() {
        // Missing credentials already satisfy a clear request.
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(1168) {
                return Err(error.to_string());
            }
        }
        return Ok(());
    }
    if token.len() > 2560 {
        return Err("Token is too long.".into());
    }
    let mut bytes = token.into_bytes();
    let mut username: Vec<u16> = "GitHub\0".encode_utf16().collect();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: bytes.len() as u32,
        CredentialBlob: bytes.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: username.as_mut_ptr(),
        ..Default::default()
    };
    // All pointers refer to live buffers for the duration of the call.
    let result = unsafe { CredWriteW(&credential, 0) };
    let error = std::io::Error::last_os_error();
    bytes.fill(0);
    if result == 0 {
        Err(error.to_string())
    } else {
        Ok(())
    }
}
