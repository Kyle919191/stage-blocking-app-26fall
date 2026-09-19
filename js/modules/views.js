// views.js - 视图管理模块
import { BlockingApp } from '../services/firebase.js';
import { log, logError } from '../utils/logger.js';
import { showStatus, getCharacterByName, safeSetProperty, getSceneCharactersList, sortMovements } from '../utils/helpers.js';
import { startEditLine } from './lines.js';
import { features } from '../config.js';
import { getStageImageForScene } from './stageImages.js';

// 使用 BlockingApp.state 作为统一状态源（不再使用本地变量）

// 导出获取器（从 BlockingApp.state 读取）
export function getCurrentView() { return BlockingApp.state.currentView; }
export function getSelectedLine() { return BlockingApp.state.selectedLine; }
export function getSelectedCharIndex() { return BlockingApp.state.selectedCharIndex; }
export function getSelectedCharacter() { return BlockingApp.state.selectedCharacter; }
export function setSelectedCharacter(char) { BlockingApp.state.selectedCharacter = char; }
export function getCurrentMode() { return BlockingApp.state.currentMode || 'blocking'; }

function getCharacterShortName(charName) {
    const character = window.characters?.find((c) => c.name === charName);
    if (character?.shortName) return character.shortName;
    if (character?.name) return character.name.slice(0, 1);
    if (!charName) return '';
    return String(charName).slice(0, 1);
}

function getLineMetaMap(sceneId) {
    const lines = BlockingApp.data.lines.filter((line) => line.sceneId === sceneId);
    const map = new Map();
    lines.forEach((line) => {
        const lineId = `${line.sceneId}-${line.originalIndex}`;
        map.set(lineId, line);
    });
    return map;
}

function parseLineIndex(lineId) {
    if (!lineId || typeof lineId !== 'string') return Number.MAX_SAFE_INTEGER;
    const parts = lineId.split('-');
    return parseInt(parts[parts.length - 1], 10) || Number.MAX_SAFE_INTEGER;
}

function buildSceneMovementSteps(sceneId) {
    const steps = [];
    const sceneData = window.blockingData[sceneId] || {};

    Object.keys(sceneData).forEach((charName) => {
        const charData = sceneData[charName];
        const movements = charData?.movements ? [...charData.movements] : [];
        sortMovements(movements);
        movements.forEach((movement) => {
            steps.push({
                charName,
                movement,
                movementIndex: charData.movements.indexOf(movement),
                lineId: movement.lineId || null,
                charIndex: movement.charIndex ?? null,
                timestamp: movement.timestamp || 0,
                isLinked: !!(movement.lineId && movement.charIndex !== undefined)
            });
        });
    });

    steps.sort((a, b) => {
        if (a.isLinked && b.isLinked) {
            const lineDiff = parseLineIndex(a.lineId) - parseLineIndex(b.lineId);
            if (lineDiff !== 0) return lineDiff;
            const charDiff = (a.charIndex || 0) - (b.charIndex || 0);
            if (charDiff !== 0) return charDiff;
            return (a.timestamp || 0) - (b.timestamp || 0);
        }
        if (a.isLinked && !b.isLinked) return -1;
        if (!a.isLinked && b.isLinked) return 1;
        return (a.timestamp || 0) - (b.timestamp || 0);
    });

    return steps;
}

function buildSnapshotSequence(sceneId, steps) {
    const sceneData = window.blockingData[sceneId] || {};
    const currentPositions = {};

    Object.keys(sceneData).forEach((charName) => {
        const initial = sceneData[charName]?.initial;
        if (initial) {
            currentPositions[charName] = {
                x: initial.x,
                y: initial.y,
                isInitial: true,
                movementIndex: -1
            };
        }
    });

    const snapshots = [];
    // Step 1: 开场（初始位置）
    snapshots.push({
        index: 0,
        step: {
            charName: null,
            movement: null,
            lineId: null,
            charIndex: null,
            timestamp: 0,
            isLinked: false,
            isInitialSnapshot: true
        },
        positions: JSON.parse(JSON.stringify(currentPositions))
    });

    steps.forEach((step, idx) => {
        currentPositions[step.charName] = {
            x: step.movement.x,
            y: step.movement.y,
            isInitial: false,
            movementIndex: step.movementIndex
        };
        snapshots.push({
            index: idx + 1,
            step,
            positions: JSON.parse(JSON.stringify(currentPositions))
        });
    });
    return snapshots;
}

function formatStepTitle(step, lineMetaMap) {
    if (step.isInitialSnapshot) return '开场初始位置';
    if (!step.isLinked) return `自由走位 · ${step.charName}`;
    return `${step.charName} 走位`;
}

function formatStepSubtitle(step, lineMetaMap) {
    if (step.isInitialSnapshot) return '开场';
    if (!step.isLinked) return '未关联台词';

    const line = lineMetaMap.get(step.lineId);
    if (!line) return '已关联台词';

    const sceneLabel = `第${line.sceneId}场`;
    const sentenceLabel = `第${(line.originalIndex ?? 0) + 1}句`;
    const charLabel = `第${(step.charIndex ?? 0) + 1}字`;
    return `${sceneLabel} · ${sentenceLabel} · ${charLabel}`;
}

function formatStepLinePreview(step, lineMetaMap) {
    if (step.isInitialSnapshot) return '开场状态：使用所有已设置初始位置';
    if (!step.isLinked) return `角色：${step.charName} · 自由走位（未关联台词）`;

    const line = lineMetaMap.get(step.lineId);
    if (!line) return `角色：${step.charName} · 已关联台词`;

    const speaker = line.character || '舞台指示';
    const content = line.content || '';
    const idx = Math.max(0, step.charIndex || 0);
    const start = Math.max(0, idx - 10);
    const end = Math.min(content.length, idx + 12);
    const snippet = content.slice(start, end);
    return `角色：${speaker} · "${snippet}${end < content.length ? '...' : ''}"`;
}

function renderSnapshotPreview(snapshot, stageImageSrc) {
    const markerHtml = Object.entries(snapshot.positions).map(([charName, marker]) => {
        const character = window.characters.find((c) => c.name === charName);
        const color = character?.color || '#ddd';
        const label = character?.name || charName;
        const shortName = getCharacterShortName(charName);
        return `<div class="blocking-step-marker" style="left:${marker.x}%;top:${marker.y}%;background:${color};" title="${label}">${shortName}</div>`;
    }).join('');

    return `
        <div class="blocking-step-preview">
            <img src="${stageImageSrc}" alt="snapshot">
            <div class="blocking-step-overlay">${markerHtml}</div>
        </div>
    `;
}

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
    document.getElementById('blockingViewBtn').classList.toggle('active', view === 'blocking');

    // 模式切换只在台词视图显示
    const modeToggle = document.getElementById('modeToggle');
    if (modeToggle) {
        modeToggle.style.display = view === 'lines' ? 'flex' : 'none';
    }

    BlockingApp.state.selectedLine = null;
    BlockingApp.state.selectedCharIndex = null;
    BlockingApp.state.selectedCharacter = null;
    BlockingApp.state.selectedBlockingSnapshot = null;
    BlockingApp.state.addingFreeMovement = false;

    if (view === 'lines') {
        displayLines(window.currentScene.id);
    } else if (view === 'characters') {
        displayCharacters(window.currentScene.id);
    } else {
        displayBlockingTimeline(window.currentScene.id);
    }

    if (window.renderStageView) window.renderStageView();
}

export function displayBlockingTimeline(sceneId) {
    const container = document.getElementById('panelContent');
    const movementsPanel = document.getElementById('movementsPanel');
    if (movementsPanel) {
        movementsPanel.style.display = 'none';
    }

    const steps = buildSceneMovementSteps(sceneId);
    const snapshots = buildSnapshotSequence(sceneId, steps);
    if (snapshots.length === 0) {
        container.innerHTML = '<div class="loading">该场次暂无可展示的舞台状态</div>';
        BlockingApp.state.selectedBlockingSnapshot = null;
        if (window.renderStageView) window.renderStageView();
        return;
    }

    window.blockingTimelineSnapshots = snapshots;
    const lineMetaMap = getLineMetaMap(sceneId);
    const stageImageSrc = getStageImageForScene(sceneId) || 'stage-layouts/default-blank.png';

    container.innerHTML = snapshots.map((snapshot, idx) => {
        const title = formatStepTitle(snapshot.step, lineMetaMap);
        const subtitle = formatStepSubtitle(snapshot.step, lineMetaMap);
        const linePreview = formatStepLinePreview(snapshot.step, lineMetaMap);
        return `
            <div class="blocking-step-card ${idx === 0 ? 'active' : ''}" data-step-index="${idx}" onclick="selectBlockingStep(${idx})">
                <div class="blocking-step-header">
                    <span>Step ${idx + 1}</span>
                    <span class="blocking-step-subtitle">${subtitle}</span>
                </div>
                <div class="blocking-step-title">${title}</div>
                <div class="blocking-step-line-preview">${linePreview}</div>
                ${renderSnapshotPreview(snapshot, stageImageSrc)}
            </div>
        `;
    }).join('');

    selectBlockingStep(0);
}

export function selectBlockingStep(stepIndex) {
    const snapshots = window.blockingTimelineSnapshots || [];
    const snapshot = snapshots[stepIndex];
    if (!snapshot) return;

    document.querySelectorAll('.blocking-step-card').forEach((el) => el.classList.remove('active'));
    const currentCard = document.querySelector(`.blocking-step-card[data-step-index="${stepIndex}"]`);
    if (currentCard) currentCard.classList.add('active');

    BlockingApp.state.selectedBlockingSnapshot = snapshot;
    BlockingApp.state.selectedLine = snapshot.step.lineId || null;
    BlockingApp.state.selectedCharIndex = snapshot.step.charIndex || 0;

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
        const markedPositions = new Map();  // charIndex -> [{ charName, color, timestamp }]
        if (!line.isNew) {
            const sceneData = window.blockingData[sceneId] || {};
            Object.keys(sceneData).forEach(charName => {
                const charData = sceneData[charName];
                if (charData && charData.movements) {
                    charData.movements.forEach(m => {
                        if (m.lineId === lineId) {
                            const movingChar = window.characters.find(c => c.name === charName);
                            const existing = markedPositions.get(m.charIndex) || [];
                            existing.push({
                                charName: charName,
                                color: movingChar?.color || '#888',
                                timestamp: m.timestamp || 0
                            });
                            markedPositions.set(m.charIndex, existing);
                        }
                    });
                }
            });
        }

        // 获取备注位置
        const lineNotes = window.notes[sceneId]?.[lineId] || [];
        const notePositions = new Map();
        lineNotes.forEach(n => {
            const existing = notePositions.get(n.charIndex) || [];
            existing.push(n);
            notePositions.set(n.charIndex, existing);
        });

        const chars = displayContent.split('').map((char, charIndex) => {
            // 检查是否有走位标记
            const movementInfos = markedPositions.get(charIndex) || [];
            let movementMarker = '';
            if (movementInfos.length > 0) {
                movementMarker = movementInfos.map((movementInfo) => {
                    const shortName = getCharacterShortName(movementInfo.charName);
                    return `<span class="movement-marker" style="background: ${movementInfo.color};" title="${movementInfo.charName} 移动（点击删除）" onclick="event.stopPropagation(); deleteMovement('${lineId}', ${charIndex}, '${movementInfo.charName}', ${movementInfo.timestamp})">${shortName}</span>`;
                }).join('');
            }

            // 检查是否有备注
            const notesAtPosition = notePositions.get(charIndex) || [];
            let noteMarker = '';
            if (notesAtPosition.length > 0) {
                noteMarker = notesAtPosition.map((note) => {
                    const noteChar = window.characters.find(c => c.name === note.characterId || c.id === note.characterId);
                    const noteColor = noteChar?.color || '#888';
                    return `<span class="note-marker" style="background: ${noteColor};" title="点击删除" onclick="event.stopPropagation(); deleteNote('${lineId}', ${charIndex}, ${note.createdAt || 0})">[${note.characterId}：${note.note}]</span>`;
                }).join('');
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
                ${character ? `<span class="character-badge" style="background: ${character.color}">${getCharacterShortName(character.name)}</span>` : ''}
                ${character?.fullName || line.character}
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
                <span class="character-badge" style="background: ${character.color}">${getCharacterShortName(character.name)}</span>
                <div class="character-info">
                    <div class="character-name">${getCharacterShortName(character.name)}</div>
                    <div class="character-full-name">${character.fullName || character.name}</div>
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
window.displayBlockingTimeline = displayBlockingTimeline;
window.filterLines = filterLines;
window.filterCharacters = filterCharacters;
window.selectCharacter = selectCharacter;
window.selectCharacterForView = selectCharacterForView;
window.selectBlockingStep = selectBlockingStep;
