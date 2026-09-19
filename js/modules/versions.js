// versions.js - 版本管理模块
import { BlockingApp, versionsRef, blockingRef, dialogueEditsRef, lineOperationsRef, notesRef, scenesRef } from '../services/firebase.js';
import { log, logError } from '../utils/logger.js';
import { showStatus, parseCharacterNames } from '../utils/helpers.js';

// 模块内部状态
let versions = [];
// 使用 BlockingApp.state.isLoadingFromFirebase 作为统一状态

// 加载版本历史
export function loadVersions() {
    const versionsListener = versionsRef.orderByChild('timestamp').on('value', (snapshot) => {
        versions = [];
        snapshot.forEach((childSnapshot) => {
            versions.push({
                id: childSnapshot.key,
                ...childSnapshot.val()
            });
        });
        versions.reverse();
        renderVersionList();
    });

    BlockingApp.firebase.listeners.push({
        ref: versionsRef,
        listener: versionsListener,
        off: () => versionsRef.off('value', versionsListener)
    });
}

// 渲染版本列表
export function renderVersionList() {
    const listEl = document.getElementById('versionList');

    if (versions.length === 0) {
        listEl.innerHTML = '<div class="loading">暂无版本快照</div>';
        return;
    }

    listEl.innerHTML = versions.map(version => {
        const date = new Date(version.timestamp);
        const timeStr = date.toLocaleString('en-US', { timeZone: 'America/Chicago' });

        return `
            <div class="version-item">
                <div class="version-item-name">${version.name}</div>
                <div class="version-item-time">${timeStr}</div>
                <div class="version-item-actions">
                    <button onclick="restoreVersion('${version.id}')">恢复此版本</button>
                    <button onclick="deleteVersion('${version.id}')">删除</button>
                </div>
            </div>
        `;
    }).join('');
}

// 打开保存版本模态框
export function openSaveVersionModal() {
    document.getElementById('saveVersionModal').classList.add('active');
    document.getElementById('versionName').value = '';
    document.getElementById('versionName').focus();
}

// 关闭保存版本模态框
export function closeSaveVersionModal() {
    document.getElementById('saveVersionModal').classList.remove('active');
}

// 收集完整版本数据
function collectCompleteVersionData(baseVersionData) {
    const completeData = { ...baseVersionData };

    const sceneCharacters = {};
    BlockingApp.data.scenes.forEach(scene => {
        if (scene.characters && scene.characters.length > 0) {
            sceneCharacters[scene.id] = scene.characters;
        }
    });

    completeData.sceneCharacters = sceneCharacters;

    return completeData;
}

// 保存版本
export async function saveVersion() {
    const name = document.getElementById('versionName').value.trim();

    if (!name) {
        alert('请输入版本名称');
        return;
    }

    try {
        showStatus('正在保存版本...', 'info');

        const versionId = Date.now().toString();
        const baseVersionData = {
            name: name,
            timestamp: Date.now(),
            data: JSON.parse(JSON.stringify(window.blockingData)),
            dialogueEdits: JSON.parse(JSON.stringify(window.dialogueEdits)),
            lineOperations: JSON.parse(JSON.stringify(window.lineOperations)),
            notes: JSON.parse(JSON.stringify(window.notes || {}))
        };

        const completeVersionData = collectCompleteVersionData(baseVersionData);

        await versionsRef.child(versionId).set(baseVersionData);
        showStatus('版本已保存，正在同步到 GitHub...', 'info');

        closeSaveVersionModal();

        // 触发 GitHub Actions 同步
        if (window.triggerGitHubSync) {
            await window.triggerGitHubSync(name, BlockingApp.data.datasetId || 'default');
        }

    } catch (error) {
        console.error('保存版本失败:', error);
        showStatus('保存版本失败: ' + error.message, 'error');
    }
}

// 恢复版本
export async function restoreVersion(versionId) {
    if (!confirm('确定要恢复到这个版本吗？当前未保存的修改将会丢失。')) {
        return;
    }

    try {
        const snapshot = await versionsRef.child(versionId).once('value');
        const version = snapshot.val();

        if (version && version.data) {
            BlockingApp.state.isLoadingFromFirebase = true;

            window.blockingData = JSON.parse(JSON.stringify(version.data));
            await blockingRef.set(window.blockingData);

            if (version.dialogueEdits) {
                window.dialogueEdits = JSON.parse(JSON.stringify(version.dialogueEdits));
                await dialogueEditsRef.set(window.dialogueEdits);
            } else {
                window.dialogueEdits = {};
                await dialogueEditsRef.remove();
            }

            if (version.lineOperations) {
                window.lineOperations = JSON.parse(JSON.stringify(version.lineOperations));
                await lineOperationsRef.set(window.lineOperations);
            } else {
                window.lineOperations = { added: {}, deleted: {} };
                await lineOperationsRef.remove();
            }

            if (version.notes) {
                window.notes = JSON.parse(JSON.stringify(version.notes));
                await notesRef.set(window.notes);
            } else {
                window.notes = {};
                await notesRef.remove();
            }

            if (window.currentScene) {
                if (window.displayLines) window.displayLines(window.currentScene.id);
                if (window.renderStageView) window.renderStageView();
            }

            BlockingApp.state.isLoadingFromFirebase = false;
            toggleVersionHistory();
            showStatus('版本已恢复: ' + version.name, 'success');
        }
    } catch (error) {
        console.error('恢复版本失败:', error);
        showStatus('恢复版本失败: ' + error.message, 'error');
        BlockingApp.state.isLoadingFromFirebase = false;
    }
}

// 删除版本
export async function deleteVersion(versionId) {
    if (!confirm('确定要删除这个版本快照吗？')) {
        return;
    }

    try {
        await versionsRef.child(versionId).remove();
        showStatus('版本已删除', 'success');
    } catch (error) {
        console.error('删除版本失败:', error);
        showStatus('删除版本失败: ' + error.message, 'error');
    }
}

// 切换版本历史侧边栏
export function toggleVersionHistory() {
    const sidebar = document.getElementById('versionSidebar');
    sidebar.classList.toggle('active');
}

// 打开配置演员模态框
export function openConfigActorsModal() {
    if (!window.currentScene) {
        showStatus('请先选择一个场次', 'warning');
        return;
    }

    const modal = document.getElementById('configActorsModal');
    const header = document.getElementById('configActorsHeader');
    const checklist = document.getElementById('actorsChecklist');

    const sceneObj = BlockingApp.data.scenes.find(s => s.id === window.currentScene.id);
    if (!sceneObj) {
        console.error('场景未找到:', window.currentScene.id);
        return;
    }

    header.textContent = `配置场次演员 - ${sceneObj.name || sceneObj.id}`;

    const sceneLines = BlockingApp.data.lines.filter(line => line.sceneId === window.currentScene.id && !line.isStageDirection);
    // 解析合台词角色（如 "A、B、C" -> ["A", "B", "C"]）
    const charactersWithLinesSet = new Set();
    sceneLines.forEach(line => {
        parseCharacterNames(line.character).forEach(c => charactersWithLinesSet.add(c));
    });
    const charactersWithLines = [...charactersWithLinesSet];

    const configuredCharacters = sceneObj.characters || [];

    const actorsList = window.characters.filter(c => c.name !== '众');

    checklist.innerHTML = actorsList.map(actor => {
        const hasLines = charactersWithLines.includes(actor.name);
        const isConfigured = configuredCharacters.includes(actor.name);
        const checked = configuredCharacters.length > 0 ? isConfigured : hasLines;

        const actorDisplayName = actor.shortName
            ? `${actor.name}（${actor.shortName}）`
            : (actor.fullName || actor.name);

        return `
            <div class="actor-checkbox-item ${hasLines ? 'has-lines' : ''}">
                <input
                    type="checkbox"
                    id="actor-${actor.id}"
                    value="${actor.name}"
                    ${checked ? 'checked' : ''}
                >
                <label for="actor-${actor.id}">
                    <span>${actorDisplayName}</span>
                    ${hasLines ? '<span class="actor-badge">有台词</span>' : ''}
                </label>
            </div>
        `;
    }).join('');

    modal.classList.add('active');
}

// 关闭配置演员模态框
export function closeConfigActorsModal() {
    document.getElementById('configActorsModal').classList.remove('active');
}

// 保存演员配置
export function saveActorsConfig() {
    if (!window.currentScene) {
        showStatus('请先选择一个场次', 'warning');
        return;
    }

    const checkboxes = document.querySelectorAll('#actorsChecklist input[type="checkbox"]:checked');
    const selectedActors = Array.from(checkboxes).map(cb => cb.value);

    if (selectedActors.length === 0) {
        alert('请至少选择一个演员');
        return;
    }

    const sceneObj = BlockingApp.data.scenes.find(s => s.id === window.currentScene.id);
    if (sceneObj) {
        sceneObj.characters = selectedActors;
    }

    scenesRef.child(window.currentScene.id).update({
        characters: selectedActors
    }).then(() => {
        closeConfigActorsModal();
        showStatus(`已为场次 ${window.currentScene.id} 配置 ${selectedActors.length} 位演员`, 'success');

        // 更新状态栏
        if (window.updateSceneStats) {
            window.updateSceneStats();
        }

        if (BlockingApp.state.currentView === 'characters' && window.displayCharacters) {
            window.displayCharacters(window.currentScene.id);
        }
    }).catch((error) => {
        console.error('保存演员配置失败:', error);
        showStatus('保存失败，请重试', 'error');
    });
}

// 挂载到 window
window.loadVersions = loadVersions;
window.openSaveVersionModal = openSaveVersionModal;
window.closeSaveVersionModal = closeSaveVersionModal;
window.saveVersion = saveVersion;
window.restoreVersion = restoreVersion;
window.deleteVersion = deleteVersion;
window.toggleVersionHistory = toggleVersionHistory;
window.openConfigActorsModal = openConfigActorsModal;
window.closeConfigActorsModal = closeConfigActorsModal;
window.saveActorsConfig = saveActorsConfig;
