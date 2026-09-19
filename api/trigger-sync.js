// Server-side GitHub workflow trigger for Vercel
// Keeps PAT out of frontend bundle.

function parseJsonBody(req) {
    if (!req.body) return {};
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
        try {
            return JSON.parse(req.body);
        } catch {
            return {};
        }
    }
    return {};
}

function json(res, status, payload) {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return json(res, 405, { ok: false, error: 'method_not_allowed' });
    }

    const githubToken = process.env.GITHUB_WORKFLOW_TOKEN || '';
    const githubRepo = process.env.GITHUB_REPO || '';
    const requiredSyncKey = process.env.SYNC_API_KEY || '';

    if (!githubToken || !githubRepo) {
        return json(res, 500, {
            ok: false,
            error: 'server_not_configured',
            message: 'Missing GITHUB_WORKFLOW_TOKEN or GITHUB_REPO env var'
        });
    }

    if (requiredSyncKey) {
        const incomingKey = req.headers['x-sync-key'];
        if (incomingKey !== requiredSyncKey) {
            return json(res, 401, {
                ok: false,
                error: 'unauthorized',
                message: 'Invalid sync key'
            });
        }
    }

    const body = parseJsonBody(req);
    const dataset = String(body.dataset || 'default').trim() || 'default';
    const versionName = String(body.version_name || 'Auto sync').trim() || 'Auto sync';

    try {
        const ghResp = await fetch(
            `https://api.github.com/repos/${githubRepo}/actions/workflows/sync-firebase.yml/dispatches`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `token ${githubToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    ref: 'main',
                    inputs: {
                        dataset,
                        version_name: versionName
                    }
                })
            }
        );

        if (ghResp.status !== 204) {
            const errorText = await ghResp.text();
            return json(res, 502, {
                ok: false,
                error: 'github_dispatch_failed',
                status: ghResp.status,
                detail: errorText
            });
        }

        return json(res, 200, { ok: true, dataset, version_name: versionName });
    } catch (error) {
        return json(res, 500, {
            ok: false,
            error: 'dispatch_exception',
            message: error?.message || String(error)
        });
    }
};
