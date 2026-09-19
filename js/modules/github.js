// github.js - GitHub Actions 触发模块（通过后端 API）
import { showStatus } from '../utils/helpers.js';
import { log, logError } from '../utils/logger.js';

/**
 * 触发 GitHub Actions workflow 同步 Firebase 数据
 * @param {string} versionName - 版本名称，用于 commit 消息
 * @param {string} datasetId - 当前数据集 id
 * @returns {Promise<boolean>} 是否触发成功
 */
export async function triggerGitHubSync(versionName, datasetId = 'default') {
    const dataset = (datasetId || 'default').trim() || 'default';

    try {
        log('🔄 触发 GitHub Actions 同步...');

        const syncKey = window.localStorage.getItem('syncApiKey') || '';
        const response = await fetch('/api/trigger-sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(syncKey ? { 'x-sync-key': syncKey } : {})
            },
            body: JSON.stringify({
                version_name: versionName || 'Auto sync',
                dataset
            })
        });

        if (response.ok) {
            log('✅ GitHub Actions 同步已触发');
            showStatus('已触发 GitHub 同步', 'success');
            return true;
        } else {
            const payload = await response.json().catch(() => ({}));
            logError('GitHub 同步接口响应:', response.status, payload);
            if (response.status === 401) {
                showStatus('GitHub 同步鉴权失败：请设置 syncApiKey（若服务端要求）', 'error');
            } else if (payload?.error === 'server_not_configured') {
                showStatus('GitHub 同步未配置：请在 Vercel 设置 GITHUB_WORKFLOW_TOKEN/GITHUB_REPO', 'warning');
            } else {
                showStatus('GitHub 同步触发失败', 'error');
            }
            return false;
        }
    } catch (error) {
        logError('触发 GitHub 同步失败:', error);
        showStatus('GitHub 同步触发失败: ' + error.message, 'error');
        return false;
    }
}

// 挂载到 window
window.triggerGitHubSync = triggerGitHubSync;
