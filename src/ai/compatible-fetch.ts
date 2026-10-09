/** One bounded retry for a confirmed OpenRouter upstream parameter rejection.
 * Only failed generation HTTP requests are retried; tools have not executed.
 * Never change the model, inputs, authentication, or an explicit routing restriction.
 */
export function compatibleFetch(endpoint: string): typeof fetch {
  const openRouter = new URL(endpoint).hostname === "openrouter.ai";
  let rejectedSlug: string | undefined;
  return async (input, init) => {
    const options = { ...init, redirect: "error" as const };
    if (!openRouter || typeof options.body !== "string") return fetch(input, options);
    const body = JSON.parse(options.body);
    if (rejectedSlug) options.body = JSON.stringify({ ...body, provider: { ...body.provider, ignore: [...body.provider?.ignore ?? [], rejectedSlug] } });
    const response = await fetch(input, options);
    if (rejectedSlug || response.status !== 400 || options.signal?.aborted || body.provider?.only || body.provider?.allow_fallbacks === false) return response;
    let error;
    try { error = (await response.clone().json()).error; } catch { return response; }
    // Display names need not equal routing slugs. Restrict this workaround to
    // the upstream independently reproduced with otherwise valid small inputs.
    if (error?.message !== "Provider returned error" || error?.metadata?.provider_name !== "Sail Research" || error?.metadata?.provider_error_code !== "invalid_request_error") return response;
    rejectedSlug = "sail-research";
    return fetch(input, { ...options, body: JSON.stringify({ ...body, provider: { ...body.provider, ignore: [...body.provider?.ignore ?? [], rejectedSlug] } }) });
  };
}
