// notes.js - 备注功能模块
import { BlockingApp, notesRef } from '../services/firebase.js';
import { log, logError } from '../utils/logger.js';
import { showStatus, updateSaveStatus, getSceneCharactersList } from '../utils/helpers.js';

// 模块内部状态
let pendingNoteLineId = null;
let pendingNoteCharIndex = null;
let autoSaveTimer = null;

// 开始添加备注模式
export function startAddNote() {
    BlockingApp.state.addingNote = true;
    showStatus('添加备注：请在台词中点击一个字', 'info');
}

// 取消添加备注模式
export function cancelAddNote() {
    BlockingApp.state.addingNote = false;
    pendingNoteLineId = null;
    pendingNoteCharIndex = null;
}

// 选择字符位置（备注模式下调用）
export function selectCharacterForNote(lineId, charIndex) {
    pendingNoteLineId = lineId;
    pendingNoteCharIndex = charIndex;

    // 打开备注输入模态框
    openNoteInputModal(lineId, charIndex);
}

// 打开备注输入模态框
export function openNoteInputModal(lineId, charIndex) {
    const modal = document.getElementById('noteInputModal');
    const lineDisplay = document.getElementById('noteLineDisplay');
    const charDisplay = document.getElementById('noteCharDisplay');
    const characterSelect = document.getElementById('noteCharacterSelect');
    const noteInput = document.getElementById('noteInput');

    // 找到台词内容
    const line = BlockingApp.data.lines.find(l =>
        `${l.sceneId}-${l.originalIndex}` === lineId
    );

    if (line) {
        lineDisplay.textContent = line.content;
        // 高亮选中的字符
        const chars = line.content.split('');
        charDisplay.innerHTML = chars.map((char, idx) =>
            `<span class="${idx === charIndex ? 'highlight' : ''}">${char}</span>`
        ).join('');
    }

    // 填充角色选择
    const sceneCharacters = getSceneCharacters();
    characterSelect.innerHTML = sceneCharacters.map(charName => {
        const character = window.characters.find(c => c.name === charName);
        return `<option value="${charName}">${charName} - ${character?.fullName || ''}</option>`;
    }).join('');

    // 清空输入框
    noteInput.value = '';

    // 渲染常用动作和舞台方位
    if (window.renderCommonActionsChips) {
        window.renderCommonActionsChips('commonActionsContainer', 'noteInput');
    }
    if (window.renderStageDirections) {
        window.renderStageDirections('stageDirectionContainer', 'noteInput');
    }

    modal.classList.add('active');
    noteInput.focus();
}

// 获取当前场次的角色列表（使用公共函数，自动处理合台词解析）
function getSceneCharacters() {
    return getSceneCharactersList(
        BlockingApp.data.scenes,
        BlockingApp.data.lines,
        window.currentScene.id
    );
}

// 关闭备注输入模态框
export function closeNoteInputModal() {
    document.getElementById('noteInputModal').classList.remove('active');
    // 只清理待处理的数据，不改变模式
    pendingNoteLineId = null;
    pendingNoteCharIndex = null;
    // 如果当前是备注模式，保持 addingNote 状态
    if (BlockingApp.state.currentMode === 'note') {
        BlockingApp.state.addingNote = true;
    }
}

// 保存备注
export function saveNote() {
    const characterId = document.getElementById('noteCharacterSelect').value;
    const noteContent = document.getElementById('noteInput').value.trim();

    if (!noteContent) {
        alert('请输入备注内容');
        return;
    }

    if (!pendingNoteLineId || pendingNoteCharIndex === null) {
        alert('未选择字符位置');
        return;
    }

    const sceneId = window.currentScene.id;

    // 初始化 notes 结构
    if (!window.notes) {
        window.notes = {};
    }
    if (!window.notes[sceneId]) {
        window.notes[sceneId] = {};
    }
    if (!window.notes[sceneId][pendingNoteLineId]) {
        window.notes[sceneId][pendingNoteLineId] = [];
    }

    const noteData = {
        charIndex: pendingNoteCharIndex,
        characterId: characterId,
        note: noteContent,
        createdAt: Date.now()
    };

    // 允许同一字符位置存在多个备注
    window.notes[sceneId][pendingNoteLineId].push(noteData);

    // 保存到 Firebase
    autoSaveNotes();

    closeNoteInputModal();
    showStatus('备注已保存', 'success');

    // 刷新台词显示
    if (window.displayLines) {
        window.displayLines(sceneId);
    }
}

// 删除备注
export function deleteNote(lineId, charIndex, createdAt = null) {
    if (!confirm('确定要删除这个备注吗？')) return;

    const sceneId = window.currentScene.id;

    if (window.notes[sceneId]?.[lineId]) {
        const index = window.notes[sceneId][lineId].findIndex((n) => {
            if (createdAt) {
                return n.charIndex === charIndex && n.createdAt === createdAt;
            }
            return n.charIndex === charIndex;
        });

        if (index >= 0) {
            window.notes[sceneId][lineId].splice(index, 1);

            // 如果该行没有备注了，删除该行的记录
            if (window.notes[sceneId][lineId].length === 0) {
                delete window.notes[sceneId][lineId];
            }

            autoSaveNotes();
            showStatus('备注已删除', 'success');

            // 刷新台词显示
            if (window.displayLines) {
                window.displayLines(sceneId);
            }
        }
    }
}

// 自动保存备注到 Firebase
function autoSaveNotes() {
    // 保存修改前的状态到历史（用于撤销）
    if (window.pushHistory) {
        window.pushHistory();
    }

    updateSaveStatus('saving');

    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
    }

    autoSaveTimer = setTimeout(() => {
        notesRef.set(window.notes)
            .then(() => {
                updateSaveStatus('synced');
                // 更新状态栏
                if (window.updateSceneStats) window.updateSceneStats();
                // 更新"上一次保存的状态"（用于下次撤销）
                if (window.updateLastSavedState) window.updateLastSavedState();
            })
            .catch((error) => {
                console.error('Firebase保存备注失败:', error);
                updateSaveStatus('error');
            });
    }, 1000);
}

// 获取某行的所有备注
export function getNotesForLine(sceneId, lineId) {
    return window.notes[sceneId]?.[lineId] || [];
}

// 获取某个位置的备注
export function getNoteAtPosition(sceneId, lineId, charIndex) {
    const notes = getNotesForLine(sceneId, lineId);
    return notes.find(n => n.charIndex === charIndex);
}

// 挂载到 window
window.startAddNote = startAddNote;
window.cancelAddNote = cancelAddNote;
window.selectCharacterForNote = selectCharacterForNote;
window.openNoteInputModal = openNoteInputModal;
window.closeNoteInputModal = closeNoteInputModal;
window.saveNote = saveNote;
window.deleteNote = deleteNote;
window.getNotesForLine = getNotesForLine;
window.getNoteAtPosition = getNoteAtPosition;
