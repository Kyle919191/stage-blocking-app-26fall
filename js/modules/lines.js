// lines.js - 台词编辑功能模块
import { BlockingApp, dialogueEditsRef, lineOperationsRef } from '../services/firebase.js';
import { log, logError } from '../utils/logger.js';
import { getCurrentSceneId, validateFirebasePath, updateSaveStatus } from '../utils/helpers.js';

// 模块内部状态
let currentlyEditingLine = null;

function ensureLineOperationsShape() {
    if (!window.lineOperations) {
        window.lineOperations = { added: {}, deleted: {} };
    }
    if (!window.lineOperations.added) {
        window.lineOperations.added = {};
    }
    if (!window.lineOperations.deleted) {
        window.lineOperations.deleted = {};
    }
}

// 开始编辑行
export function startEditLine(lineId) {
    if (currentlyEditingLine) {
        if (currentlyEditingLine === lineId) {
            return;
        }
        cancelEdit(currentlyEditingLine);
    }

    currentlyEditingLine = lineId;
    const lineElement = document.querySelector(`[data-line-id="${lineId}"]`);
    if (!lineElement) return;

    const contentDiv = lineElement.querySelector('.line-content');
    const originalContent = contentDiv.getAttribute('data-original-content');

    contentDiv.contentEditable = true;
    contentDiv.classList.add('editing');
    contentDiv.focus();

    const range = document.createRange();
    range.selectNodeContents(contentDiv);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const controls = document.createElement('div');
    controls.className = 'edit-controls';
    controls.innerHTML = `
        <button class="save-btn" onclick="saveLineEdit('${lineId}')">保存</button>
        <button class="cancel-btn" onclick="cancelEdit('${lineId}')">取消</button>
        ${window.dialogueEdits[lineId] ? `<button class="restore-btn" onclick="restoreOriginal('${lineId}')">恢复原始</button>` : ''}
    `;

    lineElement.appendChild(controls);
}

// 保存编辑
export function saveLineEdit(lineId) {
    const lineElement = document.querySelector(`[data-line-id="${lineId}"]`);
    if (!lineElement) return;

    const contentDiv = lineElement.querySelector('.line-content');
    const newContent = contentDiv.textContent.trim();
    const originalContent = contentDiv.getAttribute('data-original-content');

    if (newContent === originalContent) {
        cancelEdit(lineId);
        return;
    }

    const editData = {
        content: newContent,
        originalContent: originalContent,
        editedAt: Date.now(),
        sceneId: getCurrentSceneId()
    };

    dialogueEditsRef.child(lineId).set(editData);

    window.dialogueEdits[lineId] = editData;

    currentlyEditingLine = null;
    contentDiv.contentEditable = false;
    contentDiv.classList.remove('editing');

    if (window.displayLines && window.currentScene) {
        window.displayLines(window.currentScene.id);
    }

    updateSaveStatus('saved');
}

// 取消编辑
export function cancelEdit(lineId) {
    const lineElement = document.querySelector(`[data-line-id="${lineId}"]`);
    if (!lineElement) return;

    currentlyEditingLine = null;

    if (window.displayLines && window.currentScene) {
        window.displayLines(window.currentScene.id);
    }
}

// 恢复原始内容
export function restoreOriginal(lineId) {
    if (confirm('确定要恢复原始台词吗？')) {
        dialogueEditsRef.child(lineId).remove();

        delete window.dialogueEdits[lineId];

        if (window.displayLines && window.currentScene) {
            window.displayLines(window.currentScene.id);
        }

        updateSaveStatus('saved');
    }
}

// 删除行
export function deleteLine(lineId) {
    try {
        console.log('删除行:', lineId, '场景:', window.currentScene);
        if (!confirm('确定要删除这一行吗？')) return;

        if (!window.currentScene) {
            alert('请先选择一个场次');
            return;
        }

        ensureLineOperationsShape();
        if (!window.lineOperations.deleted[window.currentScene.id]) {
            window.lineOperations.deleted[window.currentScene.id] = [];
        }
        window.lineOperations.deleted[window.currentScene.id].push(lineId);

        if (lineOperationsRef) {
            lineOperationsRef.child(`deleted/${window.currentScene.id}`).set(window.lineOperations.deleted[window.currentScene.id]);
        }

        if (window.displayLines) {
            window.displayLines(window.currentScene.id);
        }
        updateSaveStatus('saved');
    } catch(error) {
        console.error('删除行出错:', error);
        alert('删除失败: ' + error.message);
    }
}

// 显示新增行表单
export function showAddLineForm(position, lineId) {
    try {
        log('显示新增行表单:', position, lineId);
        log('lineId类型:', typeof lineId);

        if (lineId && typeof lineId !== 'string') {
            logError('lineId不是字符串:', lineId);
            lineId = null;
        }

        if (!window.currentScene) {
            alert('请先选择一个场次');
            return;
        }

        const existingForm = document.querySelector('.new-line-form');
        if (existingForm) {
            existingForm.remove();
        }

        const formHtml = `
            <div class="new-line-form" id="newLineForm">
                <div>
                    <label>类型：</label>
                    <select id="newLineType" onchange="toggleCharacterSelect()">
                        <option value="dialogue">台词</option>
                        <option value="stage">舞台指示</option>
                    </select>
                </div>
                <div id="characterSelectDiv">
                    <label>角色：</label>
                    <select id="newLineCharacter">
                        ${window.characters.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label>内容：</label>
                    <textarea id="newLineContent" rows="3" placeholder="输入内容..."></textarea>
                </div>
                <div class="form-actions">
                    <button onclick="addNewLine('${position}', ${lineId ? `'${lineId}'` : 'null'})" style="background: #4CAF50; color: white;">添加</button>
                    <button onclick="cancelAddLine()">取消</button>
                </div>
            </div>
        `;

        let insertElement = null;
        if (position === 'start') {
            insertElement = document.querySelector('.add-line-btn') || document.querySelector('.panel-content > :first-child');
        } else if (position === 'before' && lineId) {
            insertElement = document.querySelector(`#insert-before-${lineId}`);
        } else if (position === 'after' && lineId) {
            insertElement = document.querySelector(`[data-line-id="${lineId}"]`);
        }

        if (insertElement) {
            if (position === 'before') {
                insertElement.insertAdjacentHTML('afterend', formHtml);
            } else {
                insertElement.insertAdjacentHTML('afterend', formHtml);
            }
        } else {
            const container = document.getElementById('panelContent');
            if (container) {
                container.insertAdjacentHTML('beforeend', formHtml);
            } else {
                console.error('未找到容器元素');
                alert('无法显示添加表单，请刷新页面重试');
            }
        }
    } catch(error) {
        console.error('显示新增行表单出错:', error);
        alert('操作失败: ' + error.message);
    }
}

// 切换角色选择显示
export function toggleCharacterSelect() {
    const typeSelect = document.getElementById('newLineType');
    const charDiv = document.getElementById('characterSelectDiv');
    charDiv.style.display = typeSelect.value === 'dialogue' ? 'block' : 'none';
}

// 取消添加行
export function cancelAddLine() {
    const form = document.getElementById('newLineForm');
    if (form) form.remove();
}

// 添加新行
export function addNewLine(position, lineId) {
    try {
        log('添加新行:', position, lineId);
        log('当前currentScene值:', window.currentScene);
        log('currentScene类型:', typeof window.currentScene);

        if (!window.currentScene) {
            alert('请先选择一个场次');
            return;
        }

        const type = document.getElementById('newLineType').value;
        const content = document.getElementById('newLineContent').value.trim();

        if (!content) {
            alert('请输入内容');
            return;
        }

        const newLine = {
            sceneId: getCurrentSceneId(),
            content: content,
            isStageDirection: type === 'stage',
            addedAt: Date.now(),
            position: position,
            relatedLineId: lineId || null
        };

        if (type === 'dialogue') {
            newLine.character = document.getElementById('newLineCharacter').value;
        }

        const sceneId = getCurrentSceneId();
        if (!sceneId) {
            alert('无法获取场景信息');
            return;
        }

        if (typeof sceneId !== 'string') {
            logError('sceneId不是字符串:', sceneId, typeof sceneId);
            alert('场景ID格式错误，请刷新页面重试');
            return;
        }

        const newLineId = `${sceneId}-new-${Date.now()}`;

        ensureLineOperationsShape();
        if (!window.lineOperations.added[sceneId]) {
            window.lineOperations.added[sceneId] = {};
        }
        window.lineOperations.added[sceneId][newLineId] = newLine;

        const path = `added/${sceneId}/${newLineId}`;
        if (!validateFirebasePath(path)) {
            alert('数据路径无效，请刷新页面重试');
            return;
        }
        lineOperationsRef.child(path).set(newLine);

        cancelAddLine();

        if (window.displayLines) {
            window.displayLines(sceneId);
        }

        updateSaveStatus('saved');
    } catch(error) {
        logError('添加新行出错 - 完整错误:', error);
        logError('错误堆栈:', error.stack);
        logError('当前currentScene值:', window.currentScene);
        logError('getCurrentSceneId返回:', getCurrentSceneId());
        alert('添加失败: ' + error.message);
    }
}

// 挂载到 window
window.startEditLine = startEditLine;
window.saveLineEdit = saveLineEdit;
window.cancelEdit = cancelEdit;
window.restoreOriginal = restoreOriginal;
window.deleteLine = deleteLine;
window.showAddLineForm = showAddLineForm;
window.toggleCharacterSelect = toggleCharacterSelect;
window.cancelAddLine = cancelAddLine;
window.addNewLine = addNewLine;
