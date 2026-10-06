/** Share one model request between user preparation and background preparation. */
export function createPreparationRequestSlot({signal} = {}) {
    const userRequests = [];
    const backgroundRequests = [];
    let active = false;
    let closed = false;

    function acquire({signal: requestSignal, priority = 'user'} = {}) {
        return new Promise(
            function waitForRequestSlot(resolve, reject) {
                if (requestSignal?.aborted) {
                    reject(requestSignal.reason);
                    return;
                }
                if (closed) {
                    reject(signal?.reason ?? new DOMException('Preparation requests are closed.', 'AbortError'));
                    return;
                }
                const queue = priority === 'background' ? backgroundRequests : userRequests;
                const request = {resolve, reject, signal: requestSignal, cancel: cancelQueuedRequest};

                function cancelQueuedRequest() {
                    const index = queue.indexOf(request);
                    if (index === -1) return;
                    queue.splice(index, 1);
                    requestSignal.removeEventListener('abort', cancelQueuedRequest);
                    reject(requestSignal.reason);
                }

                requestSignal?.addEventListener('abort', cancelQueuedRequest, {once: true});
                queue.push(request);
                grantNextRequest();
            }
        );
    }

    function grantNextRequest() {
        if (active || closed) return;
        const request = userRequests.shift() ?? backgroundRequests.shift();
        if (!request) return;
        // Once granted, cancellation leaves release with the request's settlement owner.
        request.signal?.removeEventListener('abort', request.cancel);
        active = true;
        let released = false;
        request.resolve(
            function releaseRequestSlot() {
                if (released) return;
                released = true;
                active = false;
                grantNextRequest();
            }
        );
    }

    function dispose() {
        if (closed) return;
        closed = true;
        signal?.removeEventListener('abort', dispose);
        const error = signal?.reason ?? new DOMException('Preparation requests are closed.', 'AbortError');
        for (const queue of [userRequests, backgroundRequests]) {
            for (const request of queue) {
                request.signal?.removeEventListener('abort', request.cancel);
                request.reject(error);
            }
            queue.length = 0;
        }
    }

    signal?.addEventListener('abort', dispose, {once: true});
    if (signal?.aborted) dispose();
    return {acquire, dispose};
}
