// views.js - 视图管理模块
import { BlockingApp } from '../services/firebase.js';
import { log, logError } from '../utils/logger.js';
import { showStatus, getCharacterByName, safeSetProperty, getSceneCharactersList } from '../utils/helpers.js';
import { startEditLine } from './lines.js';
import { features } from '../config.js';

// 使用 BlockingApp.state 作为统一状态源（不再使用本地变量）

// 导出获取器（从 BlockingApp.state 读取）
export function getCurrentView() { return BlockingApp.state.currentView; }
export function getSelectedLine() { return BlockingApp.state.selectedLine; }
export function getSelectedCharIndex() { return BlockingApp.state.selectedCharIndex; }
export function getSelectedCharacter() { return BlockingApp.state.selectedCharacter; }
export function setSelectedCharacter(char) { BlockingApp.state.selectedCharacter = char; }
export function getCurrentMode() { return BlockingApp.state.currentMode || 'blocking'; }

// 模式切换（走位/备注）
export function switchMode(mode) {
    BlockingApp.state.currentMode = mode;
    BlockingApp.state.addingNote = (mode === 'note');

    document.getElementById('blockingModeBtn').classList.toggle('active', mode === 'blocking');
    document.getElementById('noteModeBtn').classList.toggle('active', mode === 'note');

    if (mode === 'note') {
        showStatus('备注模式：点击台词中的字添加备注', 'info');
    } else {
        showStatus('走位模式：点击台词中的字，然后点击舞台标记位置', 'info');
    }
}

// 更新场次状态栏
export function updateSceneStats() {
    if (!window.currentScene) return;

    const sceneId = window.currentScene.id;
    const sceneData = window.blockingData[sceneId] || {};

    // 获取场次角色（使用公共函数，自动处理合台词解析）
    const sceneCharacters = getSceneCharactersList(
        BlockingApp.data.scenes,
        BlockingApp.data.lines,
        sceneId
    );

    // 统计有初始位置的角色
    let withInitial = 0;
    let totalMovements = 0;
    Object.keys(sceneData).forEach(charName => {
        const charData = sceneData[charName];
        if (charData?.initial) withInitial++;
        if (charData?.movements) totalMovements += charData.movements.length;
    });

    // 统计备注数量
    let totalNotes = 0;
    const sceneNotes = window.notes[sceneId] || {};
    Object.values(sceneNotes).forEach(lineNotes => {
        totalNotes += lineNotes.length;
    });

    // 更新显示
    const statActors = document.getElementById('statActors');
    const statMovements = document.getElementById('statMovements');
    const statNotes = document.getElementById('statNotes');

    if (statActors) statActors.textContent = `${withInitial}/${sceneCharacters.length}`;
    if (statMovements) statMovements.textContent = totalMovements;
    if (statNotes) statNotes.textContent = totalNotes;
}

// 视图切换
export function switchView(view) {
    BlockingApp.state.currentView = view;
    document.getElementById('linesViewBtn').classList.toggle('active', view === 'lines');
    document.getElementById('charactersViewBtn').classList.toggle('active', view === 'characters');

    // 模式切换只在台词视图显示
    const modeToggle = document.getElementById('modeToggle');
    if (modeToggle) {
        modeToggle.style.display = view === 'lines' ? 'flex' : 'none';
    }

    BlockingApp.state.selectedLine = null;
    BlockingApp.state.selectedCharIndex = null;
    BlockingApp.state.selectedCharacter = null;
    BlockingApp.state.addingFreeMovement = false;

    if (view === 'lines') {
        displayLines(window.currentScene.id);
    } else {
        displayCharacters(window.currentScene.id);
    }

    if (window.renderStageView) window.renderStageView();
}

// ==================== displayLines 函数拆分 ====================

function getSafeLineOperations() {
    const lineOperations = window.lineOperations || {};
    return {
        added: lineOperations.added || {},
        deleted: lineOperations.deleted || {}
    };
}

// 辅助函数：过滤已删除的行
function filterDeletedLines(sceneLines, sceneId) {
    const { deleted } = getSafeLineOperations();
    const deletedLines = deleted[sceneId] || [];
    return sceneLines.filter((line) => {
        const lineId = `${line.sceneId}-${line.originalIndex}`;
        return !deletedLines.includes(lineId);
    });
}

// 辅助函数：插入新增的行
function insertAddedLines(sceneLines, sceneId) {
    const { added } = getSafeLineOperations();
    const addedLines = added[sceneId] || {};
    let allLines = [...sceneLines];

    Object.entries(addedLines).forEach(([newLineId, newLine]) => {
        newLine.id = newLineId;
        newLine.isNew = true;

        if (newLine.position === 'start') {
            allLines.unshift(newLine);
        } else if (newLine.position === 'before' && newLine.relatedLineId) {
            const insertIndex = allLines.findIndex(line => {
                const currentLineId = line.id || `${line.sceneId}-${line.originalIndex}`;
                return currentLineId === newLine.relatedLineId;
            });
            if (insertIndex >= 0) {
                allLines.splice(insertIndex, 0, newLine);
            } else {
                allLines.push(newLine);
            }
        } else if (newLine.position === 'after' && newLine.relatedLineId) {
            const insertIndex = allLines.findIndex(line => {
                const currentLineId = line.id || `${line.sceneId}-${line.originalIndex}`;
                return currentLineId === newLine.relatedLineId;
            });
            if (insertIndex >= 0) {
                allLines.splice(insertIndex + 1, 0, newLine);
            } else {
                allLines.push(newLine);
            }
        } else {
            allLines.push(newLine);
        }
    });

    return allLines;
}

// 辅助函数：渲染单行元素
function renderLineItem(line, sceneId, deletedLines) {
    let lineId;
    if (line.isNew) {
        lineId = line.id;
    } else {
        lineId = `${line.sceneId}-${line.originalIndex}`;
    }
    line.id = lineId;

    if (deletedLines.includes(lineId)) {
        return null;
    }

    const lineDiv = document.createElement('div');

    if (line.isStageDirection) {
        const hasEdit = window.dialogueEdits[lineId] !== undefined;
        const displayContent = hasEdit ? window.dialogueEdits[lineId].content : line.content;
        const originalContent = line.content || '';

        lineDiv.className = `line-item stage-direction ${hasEdit ? 'edited' : ''} ${line.isNew ? 'new-line' : ''}`;
        lineDiv.setAttribute('data-line-id', lineId);
        lineDiv.ondblclick = () => startEditLine(lineId);

        lineDiv.innerHTML = `
            <div class="line-actions">
                <button class="delete-line-btn" onclick="event.stopPropagation(); deleteLine('${lineId}')">删除</button>
            </div>
            <div class="line-content" data-original-content="${originalContent.replace(/"/g, '&quot;')}">${displayContent}</div>
        `;
    } else {
        const character = window.characters.find(c => c.name === line.character);
        const hasEdit = window.dialogueEdits[lineId] !== undefined;
        const displayContent = hasEdit ? window.dialogueEdits[lineId].content : line.content;
        const originalContent = line.content || '';

        // 检查所有角色的走位数据，找出在这句台词上的标记
        const markedPositions = new Map();  // charIndex -> { charName, color }
        if (!line.isNew) {
            const sceneData = window.blockingData[sceneId] || {};
            Object.keys(sceneData).forEach(charName => {
                const charData = sceneData[charName];
                if (charData && charData.movements) {
                    charData.movements.forEach(m => {
                        if (m.lineId === lineId) {
                            const movingChar = window.characters.find(c => c.name === charName);
                            markedPositions.set(m.charIndex, {
                                charName: charName,
                                color: movingChar?.color || '#888'
                            });
                        }
                    });
                }
            });
        }

        // 获取备注位置
        const lineNotes = window.notes[sceneId]?.[lineId] || [];
        const notePositions = new Map();
        lineNotes.forEach(n => {
            notePositions.set(n.charIndex, n);
        });

        const chars = displayContent.split('').map((char, charIndex) => {
            // 检查是否有走位标记
            const movementInfo = markedPositions.get(charIndex);
            let movementMarker = '';
            if (movementInfo) {
                movementMarker = `<span class="movement-marker" style="background: ${movementInfo.color};" title="${movementInfo.charName} 移动" onclick="event.stopPropagation(); deleteMovement('${lineId}', ${charIndex})">${movementInfo.charName}</span>`;
            }

            // 检查是否有备注
            const note = notePositions.get(charIndex);
            let noteMarker = '';
            if (note) {
                const noteChar = window.characters.find(c => c.name === note.characterId || c.id === note.characterId);
                const noteColor = noteChar?.color || '#888';
                noteMarker = `<span class="note-marker" style="background: ${noteColor};" title="点击删除" onclick="event.stopPropagation(); deleteNote('${lineId}', ${charIndex})">[${note.characterId}：${note.note}]</span>`;
            }

            return `<span onclick="selectCharacter('${lineId}', ${charIndex})">${char}</span>${movementMarker}${noteMarker}`;
        }).join('');

        lineDiv.className = `line-item ${hasEdit ? 'edited' : ''} ${line.isNew ? 'new-line' : ''}`;
        lineDiv.setAttribute('data-line-id', lineId);
        lineDiv.ondblclick = () => startEditLine(lineId);

        lineDiv.innerHTML = `
            <div class="line-actions">
                <button class="delete-line-btn" onclick="event.stopPropagation(); deleteLine('${lineId}')">删除</button>
            </div>
            <div class="line-character">
                ${character ? `<span class="character-badge" style="background: ${character.color}">${character.name}</span>` : ''}
                ${line.character}
            </div>
            <div class="line-content" data-original-content="${originalContent.replace(/"/g, '&quot;')}">${chars}</div>
        `;
    }

    return { lineDiv, lineId };
}

// 主函数：显示台词列表
export function displayLines(sceneId) {
    let sceneLines = BlockingApp.data.lines.filter(line => line.sceneId === sceneId);
    const container = document.getElementById('panelContent');

    // 可选功能 - 搜索
    if (features.search) {
        safeSetProperty('searchInput', 'placeholder', '搜索台词...');
    }

    const movementsPanel = document.getElementById('movementsPanel');
    if (movementsPanel) {
        movementsPanel.style.display = 'none';
    }

    const { deleted } = getSafeLineOperations();
    const deletedLines = deleted[sceneId] || [];
    sceneLines = filterDeletedLines(sceneLines, sceneId);
    const allLines = insertAddedLines(sceneLines, sceneId);

    if (allLines.length === 0) {
        container.innerHTML = '<div class="loading">该场次暂无台词</div>';
        return;
    }

    const tipDiv = document.createElement('div');
    tipDiv.style.cssText = 'padding: 8px; background: #f0f8ff; color: #555; font-size: 12px; text-align: center; margin-bottom: 10px; border-radius: 4px;';
    tipDiv.textContent = '💡 双击编辑 | 悬停显示删除按钮 | 点击➕添加新行';
    container.innerHTML = '';
    container.appendChild(tipDiv);

    allLines.forEach((line, index) => {
        const result = renderLineItem(line, sceneId, deletedLines);
        if (!result) return;

        const { lineDiv, lineId } = result;

        const insertBeforeBtn = document.createElement('button');
        insertBeforeBtn.className = 'insert-line-btn';
        insertBeforeBtn.id = `insert-before-${lineId}`;
        insertBeforeBtn.innerHTML = '➕ 在此处插入新行';
        insertBeforeBtn.onclick = () => window.showAddLineForm('before', lineId);
        container.appendChild(insertBeforeBtn);

        container.appendChild(lineDiv);
    });

    if (allLines.length > 0) {
        const insertEndBtn = document.createElement('button');
        insertEndBtn.className = 'insert-line-btn';
        insertEndBtn.innerHTML = '➕ 在末尾添加新行';
        insertEndBtn.onclick = () => window.showAddLineForm('after', allLines[allLines.length - 1].id);
        container.appendChild(insertEndBtn);
    }
}

// 显示角色列表
export function displayCharacters(sceneId) {
    const container = document.getElementById('panelContent');

    // 可选功能 - 搜索
    if (features.search) {
        safeSetProperty('searchInput', 'placeholder', '搜索角色...');
    }

    // 获取场次角色（使用公共函数，自动处理合台词解析）
    const sceneCharacters = getSceneCharactersList(
        BlockingApp.data.scenes,
        BlockingApp.data.lines,
        sceneId
    );

    const charactersHTML = sceneCharacters.map(charName => {
        const character = window.characters.find(c => c.name === charName);
        if (!character) return '';

        const charData = window.blockingData[sceneId]?.[charName];
        const hasInitial = charData?.initial;
        const movementCount = charData?.movements?.length || 0;

        return `
            <div class="character-item" data-char-name="${charName}" onclick="selectCharacterForView('${charName}')">
                <span class="character-badge" style="background: ${character.color}">${character.name}</span>
                <div class="character-info">
                    <div class="character-name">${character.name}</div>
                    <div class="character-full-name">${character.fullName}</div>
                    <div class="character-stats">
                        ${hasInitial ? '已设置初始位置' : '未设置初始位置'}
                        · ${movementCount} 次移动
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = charactersHTML;

    const movementsPanel = document.getElementById('movementsPanel');
    if (movementsPanel) {
        movementsPanel.style.display = 'block';
    }

    if (BlockingApp.state.selectedCharacter && window.renderStageView) {
        window.renderStageView();
    }
}

// 过滤台词
export function filterLines(keyword) {
    const items = document.querySelectorAll('.line-item:not(.stage-direction)');
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(keyword.toLowerCase()) ? 'block' : 'none';
    });
}

// 过滤角色
export function filterCharacters(keyword) {
    const items = document.querySelectorAll('.character-item');
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(keyword.toLowerCase()) ? 'block' : 'none';
    });
}

// 选择字符（台词视图中）
export function selectCharacter(lineId, charIndex) {
    // 如果是备注模式，调用备注函数
    if (BlockingApp.state.addingNote) {
        if (window.selectCharacterForNote) {
            window.selectCharacterForNote(lineId, charIndex);
        }
        return;
    }

    document.querySelectorAll('.line-content span.selected').forEach(el => {
        el.classList.remove('selected');
    });

    event.target.classList.add('selected');
    BlockingApp.state.selectedLine = lineId;
    BlockingApp.state.selectedCharIndex = charIndex;

    if (window.renderStageView) window.renderStageView();
    showStatus(`已选择字符，请在stage-layouts上点击标记移动位置`, 'info');
}

// 选择角色（角色视图中）
export function selectCharacterForView(charName) {
    document.querySelectorAll('.character-item').forEach(el => el.classList.remove('active'));

    const charItem = document.querySelector(`[data-char-name="${charName}"]`);
    if (charItem) {
        charItem.classList.add('active');
    }

    BlockingApp.state.selectedCharacter = charName;

    const movementsContainer = document.getElementById('movementsListContainer');
    const movementsPanel = document.getElementById('movementsPanel');

    if (movementsContainer && window.renderMovementsList) {
        movementsContainer.innerHTML = window.renderMovementsList(charName);
    }

    if (movementsPanel) {
        movementsPanel.style.display = 'block';
    }

    if (window.renderStageView) window.renderStageView();
}

// 挂载到 window
window.switchView = switchView;
window.switchMode = switchMode;
window.updateSceneStats = updateSceneStats;
window.displayLines = displayLines;
window.displayCharacters = displayCharacters;
window.filterLines = filterLines;
window.filterCharacters = filterCharacters;
window.selectCharacter = selectCharacter;
window.selectCharacterForView = selectCharacterForView;
