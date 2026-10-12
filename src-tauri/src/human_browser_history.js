// WebKit throws when a page exceeds its shared pushState/replaceState frequency
// quota. React effects that serialize an interactive chart into the URL can
// therefore unmount the entire page. Chromium ignores those excess writes.
// Keep WebKit's quota, but use that same no-op behavior for this one exception.
// Do not defer/replay writes: a delayed replacement could overwrite a newer
// navigation or a router's state. Subsequent calls work once the quota resets.
(() => {
  for (const method of ["pushState", "replaceState"]) {
    const descriptor = Object.getOwnPropertyDescriptor(History.prototype, method);
    const frequencyError = new RegExp(
      `^Attempt to use history\\.${method}\\(\\) more than [0-9]+ times per [0-9]+(?:\\.[0-9]+)? seconds$`,
    );
    Object.defineProperty(History.prototype, method, {
      ...descriptor,
      value: new Proxy(descriptor.value, {
        apply(target, receiver, args) {
          try {
            return Reflect.apply(target, receiver, args);
          } catch (error) {
            if (
              error instanceof DOMException &&
              error.name === "SecurityError" &&
              frequencyError.test(error.message)
            ) {
              return undefined;
            }
            // Preserve origin checks, serialization failures, payload quotas,
            // inactive-document errors, and invalid receivers/arguments.
            throw error;
          }
        },
      }),
    });
  }
})();
