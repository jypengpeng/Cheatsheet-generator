import React, { useState, useRef, useCallback, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
// @ts-ignore
import JSZip from 'jszip';
// @ts-ignore
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
// @ts-ignore
import pdfjsWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
// @ts-ignore
import * as mammoth from 'mammoth';

// --- Constants ---
const A4_ASPECT_RATIO = 297 / 210;
const PAGE_WIDTH_PT = 595; // Standard A4 width in points (72dpi)
const PAGE_HEIGHT_PT = PAGE_WIDTH_PT * A4_ASPECT_RATIO;
const PAGE_PADDING_PT = 40; // 40pt padding
const COLUMN_GAP_PT = 10; // Space between columns (pt)

const MAX_FONT_SIZE = 16;
const MIN_FONT_SIZE = 2;
const FONT_STEP = 0.1;

const COLUMN_HEIGHT_PT = PAGE_HEIGHT_PT - (PAGE_PADDING_PT * 2);
const PT_TO_PX = 96 / 72; // CSS 1pt = 1/72in, 1px = 1/96in
const ptToPx = (pt: number) => pt * PT_TO_PX;

// px 派生尺寸：确保屏幕预览与打印一致（打印也按 96DPI 渲染 px）
const PAGE_WIDTH_PX = ptToPx(PAGE_WIDTH_PT);
const PAGE_HEIGHT_PX = ptToPx(PAGE_HEIGHT_PT);
const PAGE_PADDING_PX = ptToPx(PAGE_PADDING_PT);
const COLUMN_GAP_PX = ptToPx(COLUMN_GAP_PT);
const COLUMN_HEIGHT_PX = ptToPx(COLUMN_HEIGHT_PT);

// 高 DPI 导出参数
const EXPORT_DPI = 300; // 240~300 DPI 皆可，这里默认 300DPI
const EXPORT_IMAGE_QUALITY = 0.92; // JPEG 质量（0~1）

const DEFAULT_MARKDOWN = `# Markdown 页面适配器 (自动布局版)

这是一个智能排版工具，旨在帮助您将 Markdown 文本完美地排入两页 A4 纸中。

## 如何使用

1.  **输入内容**: 在编辑器中粘贴或输入您的 Markdown 文本。
2.  **点击排版**: 点击“智能排版”按钮。
3.  **预览结果**: 系统会自动寻找最佳布局（优先采用更多分栏，其次缩小字号），并在右侧预览区域展示结果。
4.  **微调字号**: 您可以使用预览上方的 +/- 按钮微调最终的字体大小。

## 功能特性

*   **自动字号调整**: 从 ${MAX_FONT_SIZE}pt 开始，逐步减小字号，直到内容适配。
*   **智能多栏布局**: 自动选择 1 到 4 栏的最佳布局以容纳内容。
*   **保留格式**: 支持所有标准的 Markdown 语法，如标题、列表、粗体、斜体等。
*   **打印友好**: 您可以直接使用浏览器的打印功能打印预览的页面。

---

> 如果文本内容过多，即使调整到最小字号（${MIN_FONT_SIZE}pt）和最密集的布局也无法容纳在两页内，系统会给出提示。

现在，请尝试粘贴您自己的内容！
`;


// --- SVG Icons ---
const SpinnerIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
);

const CheckCircleIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
);

const ExclamationTriangleIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
);


const App: React.FC = () => {
    const [markdown, setMarkdown] = useState<string>(DEFAULT_MARKDOWN);
    const [formattedHtml, setFormattedHtml] = useState<string>('');
    const [finalFontSize, setFinalFontSize] = useState<number | null>(null);
    const [finalNumColumns, setFinalNumColumns] = useState<number>(2);
    const [totalPages, setTotalPages] = useState<number>(2);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [columnOption, setColumnOption] = useState<'auto' | '1' | '2' | '3' | '4'>('auto');

    // --- AI Integration States ---
    const [aiBaseUrl, setAiBaseUrl] = useState<string>(() => localStorage.getItem('ai_base_url') || 'https://api.openai.com');
    const [aiApiKey, setAiApiKey] = useState<string>(() => localStorage.getItem('ai_api_key') || '');
    const [aiModels, setAiModels] = useState<string[]>(() => {
        try {
            const raw = localStorage.getItem('ai_models');
            return raw ? JSON.parse(raw) as string[] : [];
        } catch {
            return [];
        }
    });
    const [aiSelectedModel, setAiSelectedModel] = useState<string>(() => localStorage.getItem('ai_model') || '');
    const [aiConnecting, setAiConnecting] = useState<boolean>(false);
    const [aiConnected, setAiConnected] = useState<boolean>(false);
    const [aiSourceText, setAiSourceText] = useState<string>('');
    const [aiFiles, setAiFiles] = useState<File[]>([]);
    const [aiGenerating, setAiGenerating] = useState<boolean>(false);
    const [aiMessage, setAiMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
    const [aiGenSuccess, setAiGenSuccess] = useState<boolean>(false);
    
    const measurementRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const calculatePages = async () => {
            if (!formattedHtml || !finalFontSize || !measurementRef.current) {
                if (!formattedHtml) {
                    setTotalPages(2); // Reset to default when no content
                }
                return;
            }

            const container = measurementRef.current;
            container.innerHTML = formattedHtml;
            const currentColumnWidthPt = (PAGE_WIDTH_PT - (PAGE_PADDING_PT * 2) - (COLUMN_GAP_PT * (finalNumColumns - 1))) / finalNumColumns;
            const currentColumnWidthPx = ptToPx(currentColumnWidthPt);
            
            container.style.width = `${currentColumnWidthPx}px`;
            container.style.fontSize = `${finalFontSize}pt`;
            
            await new Promise(resolve => requestAnimationFrame(resolve)); // Let browser render

            const totalContentHeightPx = container.scrollHeight;
            const totalColumnsPerPage = finalNumColumns;
            const heightPerColumnPx = COLUMN_HEIGHT_PX;
            
            const totalColumnUnits = Math.ceil(totalContentHeightPx / heightPerColumnPx);
            const numPages = Math.ceil(totalColumnUnits / totalColumnsPerPage);

            setTotalPages(numPages > 0 ? numPages : 1);

            container.innerHTML = ''; // Clean up
        };

        calculatePages();
    }, [formattedHtml, finalFontSize, finalNumColumns]);

    // Persist AI settings
    useEffect(() => {
        localStorage.setItem('ai_base_url', aiBaseUrl);
    }, [aiBaseUrl]);
    useEffect(() => {
        localStorage.setItem('ai_api_key', aiApiKey);
    }, [aiApiKey]);
    useEffect(() => {
        localStorage.setItem('ai_model', aiSelectedModel);
    }, [aiSelectedModel]);
    useEffect(() => {
        try {
            localStorage.setItem('ai_models', JSON.stringify(aiModels));
        } catch {}
    }, [aiModels]);

    // Ensure pdf.js worker
    const ensurePdfWorker = useCallback(() => {
        try {
            if ((GlobalWorkerOptions as any).workerSrc !== pdfjsWorkerSrc) {
                GlobalWorkerOptions.workerSrc = pdfjsWorkerSrc as unknown as string;
            }
        } catch {
            // ignore
        }
    }, []);

    // Extract text from PDF
    const extractTextFromPdf = useCallback(async (file: File): Promise<string> => {
        ensurePdfWorker();
        const url = URL.createObjectURL(file);
        try {
            const task = getDocument({ url });
            const pdf = await task.promise;
            const numPages = pdf.numPages;
            const chunks: string[] = [];
            for (let i = 1; i <= numPages; i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                const text = (content.items as any[]).map((it: any) => (it?.str ?? '')).join(' ');
                chunks.push(text);
            }
            return chunks.join('\n\n');
        } finally {
            URL.revokeObjectURL(url);
        }
    }, [ensurePdfWorker]);

    // Extract text from uploaded files（本地解析，包括 PDF/DOCX/PPTX）
    const extractTextFromFiles = useCallback(async (files: File[]): Promise<{ text: string; warnings: string[] }> => {
        const warnings: string[] = [];
        const texts: string[] = [];
        for (const f of files) {
            const ext = f.name.split('.').pop()?.toLowerCase() || '';
            if (ext === 'txt' || ext === 'md') {
                try {
                    const t = await f.text();
                    const label = ext === 'txt' ? 'TXT' : 'Markdown';
                    texts.push(`# 文件：${f.name}（类型：${label}，本地解析）\n\n${t}`);
                } catch (e) {
                    warnings.push(`读取失败：${f.name}`);
                }
            } else if (ext === 'pdf') {
                try {
                    const t = await extractTextFromPdf(f);
                    texts.push(`# 文件：${f.name}（类型：PDF，本地解析，可能存在格式/布局丢失）\n\n${t}`);
                } catch (e) {
                    warnings.push(`PDF 解析失败：${f.name}`);
                }
            } else if (ext === 'docx') {
                try {
                    const t = await extractTextFromDocx(f);
                    texts.push(`# 文件：${f.name}（类型：DOCX，本地解析：mammoth）\n\n${t}`);
                } catch (e) {
                    warnings.push(`DOCX 解析失败：${f.name}`);
                }
            } else if (ext === 'pptx') {
                try {
                    const t = await extractTextFromPptx(f);
                    texts.push(`# 文件：${f.name}（类型：PPTX，本地解析：XML 文本提取）\n\n${t}`);
                } catch (e) {
                    warnings.push(`PPTX 解析失败：${f.name}`);
                }
            } else {
                warnings.push(`不支持的文件类型：${f.name}`);
            }
        }
        return { text: texts.join('\n\n---\n\n'), warnings };
    }, [extractTextFromPdf]);

    // DOCX -> Markdown（mammoth）
    const extractTextFromDocx = useCallback(async (file: File): Promise<string> => {
        const ab = await file.arrayBuffer();
        try {
            if (typeof (mammoth as any).convertToMarkdown === 'function') {
                const result = await (mammoth as any).convertToMarkdown({ arrayBuffer: ab });
                const md = (result?.value ?? '').toString();
                if (md.trim()) return md;
            }
            // fallback: HTML -> plaintext
            const htmlRes = await (mammoth as any).convertToHtml({ arrayBuffer: ab });
            const html = (htmlRes?.value ?? '').toString();
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            return tmp.textContent || tmp.innerText || '';
        } catch (e) {
            throw e;
        }
    }, []);

    // PPTX -> 逐页提取 a:t 文本
    const extractTextFromPptx = useCallback(async (file: File): Promise<string> => {
        const ab = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(ab);
        const slideFiles = Object.keys(zip.files)
            .filter(n => n.startsWith('ppt/slides/slide') && n.endsWith('.xml'))
            .sort((a, b) => {
                const ai = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] || '0', 10);
                const bi = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] || '0', 10);
                return ai - bi;
            });
        const slidesMarkdown: string[] = [];
        for (let idx = 0; idx < slideFiles.length; idx++) {
            const name = slideFiles[idx];
            const xml = await zip.file(name)!.async('text');
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            const tNodes = Array.from(doc.getElementsByTagName('a:t'));
            const texts = tNodes.map(n => (n.textContent || '').trim()).filter(s => s.length > 0);
            if (texts.length === 0) continue;
            const items = texts.map(s => `- ${s}`).join('\n');
            slidesMarkdown.push(`## 幻灯片 ${idx + 1}\n${items}`);
        }
        return slidesMarkdown.join('\n\n');
    }, []);

    // --- API URL 兼容（自动规避重复 /v1） ---
    const buildApiUrl = useCallback((baseUrl: string, endpointPath: string): string => {
        const root = baseUrl
            .trim()
            .replace(/\/+$/, '')
            .replace(/\/v1$/i, '');
        const path = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
        return `${root}${path}`;
    }, []);

    const handleFilesChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const fl = Array.from(e.target.files || []) as File[];
        setAiFiles(fl);
        if (fl.length === 0) return;
        setAiMessage({ type: 'info', text: '正在提取文件文本...' });
        const { text, warnings } = await extractTextFromFiles(fl);
        setAiSourceText(prev => {
            const base = prev?.trim() ? (prev.trim() + '\n\n---\n\n') : '';
            return base + text;
        });
        if (warnings.length > 0) {
            setAiMessage({ type: 'error', text: warnings.join('；') });
        } else {
            setAiMessage({ type: 'success', text: '文件文本提取完成。' });
        }
    }, [extractTextFromFiles]);

    // Connect & fetch models
    const fetchModels = useCallback(async (baseUrl: string, apiKey: string): Promise<string[]> => {
        const url = buildApiUrl(baseUrl, '/v1/models');
        const resp = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });
        if (!resp.ok) {
            throw new Error(`获取模型失败：${resp.status} ${resp.statusText}`);
        }
        const data = await resp.json();
        const ids: string[] = Array.isArray(data?.data) ? data.data.map((m: any) => m?.id).filter(Boolean) : [];
        return ids;
    }, [buildApiUrl]);

    const handleConnect = useCallback(async () => {
        if (!aiApiKey.trim()) {
            setAiMessage({ type: 'error', text: '请填写 API Key。' });
            return;
        }
        setAiConnecting(true);
        setAiMessage(null);
        try {
            const ids = await fetchModels(aiBaseUrl, aiApiKey);
            const sorted = ids.slice().sort();
            const fallback = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini', 'gpt-3.5-turbo'];
            const finalModels = sorted.length > 0 ? sorted : fallback;
            setAiModels(finalModels);
            const preferred = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini', 'gpt-3.5-turbo'];
            const picked = preferred.find(m => finalModels.includes(m)) || finalModels[0] || '';
            setAiSelectedModel(picked);
            setAiConnected(true);
            setAiMessage({ type: 'success', text: '连接成功，已加载模型列表。' });
        } catch (e: any) {
            const fallback = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini', 'gpt-3.5-turbo'];
            setAiModels(fallback);
            setAiSelectedModel(fallback[0]);
            setAiConnected(false);
            setAiMessage({ type: 'error', text: `连接失败：${e?.message || e}` });
        } finally {
            setAiConnecting(false);
        }
    }, [aiApiKey, aiBaseUrl, fetchModels]);

    // OpenAI Chat Completions call
    const callChatCompletions = useCallback(async (params: {
        baseUrl: string;
        apiKey: string;
        model: string;
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
        temperature?: number;
    }): Promise<string> => {
        const url = buildApiUrl(params.baseUrl, '/v1/chat/completions');
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${params.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: params.model,
                temperature: params.temperature ?? 0.2,
                messages: params.messages
            })
        });
        if (!resp.ok) {
            let msg = `${resp.status} ${resp.statusText}`;
            try {
                const errData = await resp.json();
                if (errData?.error?.message) msg = errData.error.message;
            } catch {}
            throw new Error(`调用模型失败：${msg}`);
        }
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            const merged = content.map((p: any) => (p?.text ?? '')).join('');
            return merged;
        }
        return '';
    }, [buildApiUrl]);

    // （移除远端文件上传路径，保持本地解析逻辑）
    // Chunk helper
    const chunkText = (text: string, chunkSize: number): string[] => {
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += chunkSize) {
            chunks.push(text.slice(i, i + chunkSize));
        }
        return chunks;
    };

    const generateKnowledgeMarkdown = useCallback(async () => {
        const src = aiSourceText.trim();
        if (!src) {
            setAiMessage({ type: 'error', text: '请输入文本或上传文件。' });
            return;
        }
        if (!aiApiKey.trim() || !aiSelectedModel.trim()) {
            setAiMessage({ type: 'error', text: '请先填写 Key 并连接选择模型。' });
            return;
        }
        setAiGenerating(true);
        setAiGenSuccess(false);
        setAiMessage({ type: 'info', text: '正在生成知识点 Markdown...' });
        try {
            const basePrompt = '你是一个严谨的中文助教。请从提供的材料（如课件、考试题）中提炼结构化知识点，要求：1) 主题-子主题层次清晰；2) 关键概念、定义、公式/代码、例题要点、易错点与对比；3) 给出适合速记的条目化要点；4) 输出严格使用中文 Markdown，以 # / ## / ### 标题组织，列表为 - 项，必要时用代码块与公式块；5) 末尾给出简短总结与复习建议；6) 禁止客套或模型自述。';
            const fileTypeLabel: Record<string, string> = { pdf: 'PDF', docx: 'DOCX', pptx: 'PPTX', md: 'Markdown', txt: 'TXT' };
            const typesIncluded = Array.from(new Set(aiFiles
                .map(f => (f.name.split('.').pop()?.toLowerCase() || ''))
                .filter(Boolean)
                .map(ext => fileTypeLabel[ext] || ext.toUpperCase())));
            const sourceNote = typesIncluded.length > 0
                ? `注意：本次材料来自本地解析（包含：${typesIncluded.join(', ')}），可能存在格式/布局/公式渲染等细节丢失或换行错乱。请在总结时尽量修复明显格式问题，并对不确定处标注“可能不完整”。`
                : `注意：材料主要来自纯文本输入。`;
            const SYSTEM_PROMPT = `${basePrompt}\n\n${sourceNote}`;

            const MAX_CHARS = 120000; // 简易阈值（按字符近似token）
            let finalMd = '';
            if (src.length <= MAX_CHARS) {
                finalMd = await callChatCompletions({
                    baseUrl: aiBaseUrl,
                    apiKey: aiApiKey,
                    model: aiSelectedModel,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: src }
                    ],
                    temperature: 0.2
                });
            } else {
                const PART_SIZE = 60000;
                const parts = chunkText(src, PART_SIZE);
                const partSummaries: string[] = [];
                for (let idx = 0; idx < parts.length; idx++) {
                    const p = parts[idx];
                    const md = await callChatCompletions({
                        baseUrl: aiBaseUrl,
                        apiKey: aiApiKey,
                        model: aiSelectedModel,
                        messages: [
                            { role: 'system', content: SYSTEM_PROMPT + ' 请只对当前分片生成该分片的知识点笔记（Markdown）。' },
                            { role: 'user', content: `分片 ${idx + 1}/${parts.length}\n\n${p}` }
                        ],
                        temperature: 0.2
                    });
                    partSummaries.push(`## 分片 ${idx + 1} 总结\n\n${md}`);
                }
                const mergedInput = partSummaries.join('\n\n---\n\n');
                finalMd = await callChatCompletions({
                    baseUrl: aiBaseUrl,
                    apiKey: aiApiKey,
                    model: aiSelectedModel,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT + ' 将多份分片总结合并为一份完整、去重、结构清晰的最终笔记（Markdown）。' },
                        { role: 'user', content: mergedInput }
                    ],
                    temperature: 0.2
                });
            }
            if (!finalMd?.trim()) {
                throw new Error('模型未返回内容。');
            }
            setMarkdown(finalMd.trim());
            setAiGenSuccess(true);
            setAiMessage({ type: 'success', text: '生成完成，内容已填入左侧编辑器。可点击“智能排版”。' });
        } catch (e: any) {
            setAiMessage({ type: 'error', text: e?.message || '生成失败' });
        } finally {
            setAiGenerating(false);
        }
    }, [aiSourceText, aiApiKey, aiSelectedModel, aiBaseUrl, callChatCompletions, aiFiles]);

    const handleFormat = useCallback(async () => {
        setIsLoading(true);
        setFormattedHtml('');
        setFinalFontSize(null);
        setStatusMessage(null);

        await new Promise(resolve => setTimeout(resolve, 50));

        if (!measurementRef.current) {
            setStatusMessage({ type: 'error', text: '无法初始化排版引擎。' });
            setIsLoading(false);
            return;
        }

        const container = measurementRef.current;
        let foundFit = false;

        const unsafeHtml = await marked.parse(markdown);
        const cleanHtml = DOMPurify.sanitize(unsafeHtml);
        container.innerHTML = cleanHtml;

        // Determine columns to try: auto (4 -> 1) or user-selected fixed column count
        const columnsToTry = columnOption === 'auto' ? [4, 3, 2, 1] : [parseInt(columnOption, 10)];
        for (const numCols of columnsToTry) {
            const currentColumnWidthPt = (PAGE_WIDTH_PT - (PAGE_PADDING_PT * 2) - (COLUMN_GAP_PT * (numCols - 1))) / numCols;
            // 两页高度阈值（px）
            const totalAvailableHeightPx = COLUMN_HEIGHT_PX * 2 * numCols;
            container.style.width = `${ptToPx(currentColumnWidthPt)}px`;

            // Inner loop for font size (MAX -> MIN)
            for (let fontSize = MAX_FONT_SIZE; fontSize >= MIN_FONT_SIZE; fontSize -= FONT_STEP) {
                container.style.fontSize = `${fontSize}pt`;
                
                await new Promise(resolve => requestAnimationFrame(resolve));

                if (container.scrollHeight <= totalAvailableHeightPx) {
                    setFormattedHtml(cleanHtml);
                    setFinalFontSize(fontSize);
                    setFinalNumColumns(numCols);
                    setStatusMessage({ type: 'success', text: `排版成功！最佳布局为 ${numCols} 栏，字号 ${fontSize.toFixed(1)}pt。` });
                    foundFit = true;
                    break; // Exit font size loop
                }
            }
            if (foundFit) {
                break; // Exit columns loop
            }
        }

        if (!foundFit) {
            const chosenCols = columnOption === 'auto' ? null : parseInt(columnOption, 10);
            setStatusMessage({ type: 'error', text: chosenCols
                ? `内容太多，即使在最小字号和所选 ${chosenCols} 栏布局下也无法排入两页。请删减部分内容或选择更多分栏数。`
                : '内容太多，即使在最小字号和1栏布局下也无法排入两页。请删减部分内容。' });
            setFormattedHtml('');
            setFinalFontSize(null);
            setFinalNumColumns(2);
        }

        container.innerHTML = '';
        setIsLoading(false);
    }, [markdown, columnOption]);

    // When column option changes, only update column count; keep current font size.
    useEffect(() => {
        if (!formattedHtml) return;
        if (columnOption === 'auto') return; // Auto layout only when clicking "智能排版"
        const chosenCols = parseInt(columnOption, 10);
        if (Number.isFinite(chosenCols)) {
            setFinalNumColumns(chosenCols);
        }
    }, [columnOption, formattedHtml]);

    // 动态加载 html2canvas
    const ensureHtml2Canvas = async (): Promise<any> => {
        const anyWin = window as any;
        if (anyWin.html2canvas) return anyWin.html2canvas;
        await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load html2canvas'));
            document.head.appendChild(script);
        });
        return (window as any).html2canvas;
    };

    const handlePrint = async () => {
        if (!formattedHtml || !finalFontSize || !finalNumColumns) return;
        setIsLoading(true);
        try {
            const html2canvas = await ensureHtml2Canvas();
            const pageNodes = Array.from(document.querySelectorAll('.preview-page')) as HTMLElement[];
            if (pageNodes.length === 0) return;

            const scale = EXPORT_DPI / 96; // 提升到目标 DPI
            const images: string[] = [];

            for (const pageEl of pageNodes) {
                const prevShadow = pageEl.style.boxShadow;
                pageEl.style.boxShadow = 'none';
                const canvas: HTMLCanvasElement = await html2canvas(pageEl, {
                    backgroundColor: '#ffffff',
                    width: PAGE_WIDTH_PX,
                    height: PAGE_HEIGHT_PX,
                    scale,
                    useCORS: true,
                    allowTaint: true
                });
                pageEl.style.boxShadow = prevShadow;
                const dataUrl = canvas.toDataURL('image/jpeg', EXPORT_IMAGE_QUALITY);
                images.push(dataUrl);
            }

            const styles = `
                @page { size: A4; margin: 0; }
                html, body { margin:0; padding:0; -webkit-print-color-adjust: exact; color-adjust: exact; }
                .page { width:${PAGE_WIDTH_PX}px; height:${PAGE_HEIGHT_PX}px; page-break-after: always; }
                .page img { width:100%; height:100%; object-fit: contain; }
            `;

            const html = `
                <html>
                    <head>
                        <title>Print</title>
                        <style>${styles}</style>
                    </head>
                    <body>
                        ${images.map(src => `<div class=\"page\"><img src=\"${src}\"/></div>`).join('')}
                    </body>
                </html>
            `;

            const printWindow = window.open('', '_blank');
            if (printWindow) {
                printWindow.document.write(html);
                printWindow.document.close();
                const doPrint = () => {
                    try { printWindow.focus(); printWindow.print(); } catch (e) { console.error('Printing failed:', e); }
                };
                printWindow.addEventListener('afterprint', () => printWindow.close());
                setTimeout(doPrint, 600);
            }
        } finally {
            setIsLoading(false);
        }
    };

    const adjustFontSize = (delta: number) => {
        if (!finalFontSize || !formattedHtml) return;

        const newSize = finalFontSize + delta;
        if (newSize < MIN_FONT_SIZE || newSize > MAX_FONT_SIZE) return;

        setFinalFontSize(newSize);
    };


    // Calculate column-dependent values for rendering (px)
    const columnWidth = (PAGE_WIDTH_PX - (PAGE_PADDING_PX * 2) - (COLUMN_GAP_PX * (finalNumColumns - 1))) / finalNumColumns;

    return (
        <div className="bg-neutral-50 min-h-screen font-sans text-black">
            <style>
                {`
                @media print {
                    body { margin: 0; padding: 0; }
                    .no-print { display: none !important; }
                }
                .prose-styles h1, .prose-styles h2, .prose-styles h3, .prose-styles h4, .prose-styles h5, .prose-styles h6 { color: #000 !important; font-weight: 700 !important; }
                .prose-styles p, .prose-styles li { color: #000 !important; }
                .prose-styles a { color: #000 !important; text-decoration: underline !important; }
                .prose-styles blockquote { border-left-color: rgba(0,0,0,0.25) !important; color: rgba(0,0,0,0.85) !important; border-left-width: 4px !important; padding-left: 1em !important; }
                .prose-styles code { color: #000 !important; background-color: #f8fafc !important; padding: 0.1em 0.3em !important; border-radius: 2px !important; }
                .prose-styles pre { background-color: #f5f5f5 !important; color: #000 !important; padding: 1em !important; border-radius: 2px !important; }
                `}
            </style>
            
            <div ref={measurementRef} style={{
                position: 'absolute',
                visibility: 'hidden',
                top: '-9999px',
                left: '-9999px',
                lineHeight: '1.6'
            }} className="prose-styles"></div>

            <header className="bg-white shadow-sm p-4 no-print">
                <div className="container mx-auto flex justify-between items-center">
                    <h1 className="text-3xl font-bold text-black">一键cheat sheet生成器</h1>
                </div>
            </header>

            <main className="container mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="flex flex-col no-print">
                    {/* AI 知识点总结卡片 */}
                    <div className="bg-white rounded-sm shadow-md mb-6">
                        <div className="p-4 border-b border-neutral-200 flex items-center justify-between">
                            <h2 className="text-xl font-semibold text-black">AI 知识点总结（OpenAI）</h2>
                        </div>
                        <div className="p-4 flex flex-col gap-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div className="col-span-1 md:col-span-1">
                                    <label className="block text-sm text-black/80 mb-1">Base URL</label>
                                    <input
                                        value={aiBaseUrl}
                                        onChange={(e) => setAiBaseUrl(e.target.value)}
                                        placeholder="https://api.openai.com"
                                        className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:border-neutral-800"
                                    />
                                </div>
                                <div className="col-span-1 md:col-span-1">
                                    <label className="block text-sm text-black/80 mb-1">API Key</label>
                                    <input
                                        value={aiApiKey}
                                        onChange={(e) => setAiApiKey(e.target.value)}
                                        placeholder="sk-..."
                                        type="password"
                                        className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:border-neutral-800"
                                    />
                                </div>
                                <div className="col-span-1 md:col-span-1 flex items-end gap-2">
                                    <button
                                        onClick={handleConnect}
                                        disabled={aiConnecting || !aiApiKey.trim()}
                                        className="bg-black text-white font-bold py-2 px-4 rounded-sm hover:bg-neutral-900 disabled:bg-neutral-400 disabled:cursor-not-allowed text-sm focus:outline-none focus:ring-2 focus:ring-neutral-800"
                                    >
                                        {aiConnecting ? '连接中...' : '连接并获取模型'}
                                    </button>
                                </div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                                <div className="col-span-1 md:col-span-2">
                                    <label className="block text-sm text-black/80 mb-1">模型</label>
                                    <select
                                        value={aiSelectedModel}
                                        onChange={(e) => setAiSelectedModel(e.target.value)}
                                        className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:border-neutral-800"
                                    >
                                        <option value="" disabled>请选择模型</option>
                                        {aiModels.map(m => (
                                            <option key={m} value={m}>{m}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="col-span-1 md:col-span-1">
                                    <div className={`text-sm ${aiConnected ? 'text-black' : 'text-black/60'}`}>
                                        {aiConnected ? '已连接' : '未连接'}
                                    </div>
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm text-black/80 mb-1">源材料文本（可直接输入或与文件合并）</label>
                                <textarea
                                    value={aiSourceText}
                                    onChange={(e) => setAiSourceText(e.target.value)}
                                    className="w-full min-h-[160px] p-3 border border-neutral-300 rounded-sm text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:border-neutral-800"
                                    placeholder="在此粘贴原始材料文本，或下方上传文件（txt/md/pdf/docx/pptx）"
                                />
                                <div className="mt-3 flex items-center gap-3">
                                    <input
                                        type="file"
                                        multiple
                                        accept=".txt,.md,.docx,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                                        onChange={handleFilesChange}
                                        className="text-sm"
                                    />
                                    <span className="text-xs text-black/60">支持 txt、md、pdf、docx、pptx；多个文件将合并提取文本</span>
                                </div>
                                <div className="mt-2 text-xs text-black/70">
                                    提示：当前所有文件均在本地解析后再发送给模型（包括 PDF/DOCX/PPTX），可能存在格式/公式/布局丢失或换行错乱。作者现在比较唐，不会写文件上传，有时间搞清楚了会添加的。
                                </div>
                            </div>

                            {aiMessage && (
                                <div className={`text-sm ${aiMessage.type === 'error' ? 'text-black' : aiMessage.type === 'success' ? 'text-black' : 'text-black/70'}`}>
                                    {aiMessage.text}
                                </div>
                            )}

                            <div className="flex justify-end">
                                <button
                                    onClick={generateKnowledgeMarkdown}
                                    disabled={aiGenerating || !aiSelectedModel || !aiApiKey.trim()}
                                    className="bg-black text-white font-bold py-2 px-6 rounded-sm hover:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:ring-offset-2 transition-colors duration-200 disabled:bg-neutral-400 disabled:cursor-not-allowed text-sm"
                                >
                                    {aiGenerating ? '生成中...' : '生成知识点 Markdown'}
                                </button>
                                {aiGenSuccess && (
                                    <button
                                        onClick={handleFormat}
                                        disabled={isLoading}
                                        className="ml-2 bg-black text-white font-bold py-2 px-6 rounded-sm hover:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:ring-offset-2 transition-colors duration-200 disabled:bg-neutral-400 disabled:cursor-not-allowed text-sm"
                                    >
                                        一键智能排版
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="bg-white rounded-sm shadow-md flex-grow flex flex-col">
                        <div className="p-4 border-b border-neutral-200 flex items-center justify-between">
                            <h2 className="text-xl font-semibold text-black">输入 Markdown 内容</h2>
                            <button
                                onClick={handleFormat}
                                disabled={isLoading}
                                className="bg-black text-white font-bold py-2 px-6 rounded-sm hover:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-800 transition-colors duration-200 disabled:bg-neutral-400 disabled:cursor-not-allowed text-sm no-print"
                            >
                                一键智能排版
                            </button>
                        </div>
                        <textarea
                            value={markdown}
                            onChange={(e) => setMarkdown(e.target.value)}
                            className="w-full h-full flex-grow p-4 border-0 resize-none focus:ring-0 text-sm leading-6"
                            placeholder="在此处输入或粘贴您的 Markdown..."
                            style={{minHeight: '60vh'}}
                        />
                         <div className="p-4 border-t border-neutral-200 flex items-center justify-between bg-neutral-50 rounded-b-sm">
                            {statusMessage ? (
                                <div className={`flex items-center text-sm text-black`}>
                                    {statusMessage.type === 'success' ? 
                                        <CheckCircleIcon className="w-5 h-5 mr-2" /> : 
                                        <ExclamationTriangleIcon className="w-5 h-5 mr-2" />
                                    }
                                    <span>{statusMessage.text}</span>
                                </div>
                            ) : <div/> /* Placeholder to keep layout consistent */}
                        </div>
                    </div>
                </div>

                <div className="flex flex-col">
                     <div className="bg-white rounded-sm shadow-md flex-grow flex flex-col items-center p-4 sm:p-8">
                        <div className="w-full flex justify-between items-center mb-4 no-print">
                            <h2 className="text-xl font-semibold">{`排版预览 (${totalPages}页 / ${finalNumColumns}栏)`}</h2>
                             <div className="flex items-center gap-2">
                                <span className="text-sm text-black/60">分栏:</span>
                                <select
                                    value={columnOption}
                                    onChange={(e) => setColumnOption(e.target.value as 'auto' | '1' | '2' | '3' | '4')}
                                    className="text-sm border border-neutral-300 rounded-sm px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:border-neutral-800"
                                    aria-label="选择分栏数"
                                >
                                    <option value="auto">自动</option>
                                    <option value="1">1栏</option>
                                    <option value="2">2栏</option>
                                    <option value="3">3栏</option>
                                    <option value="4">4栏</option>
                                </select>
                                <div className="w-px h-6 bg-neutral-200 mx-2"></div>
                                <span className="text-sm text-black/60">字号:</span>
                                <button
                                    onClick={() => adjustFontSize(-FONT_STEP)}
                                    disabled={!formattedHtml || isLoading || (finalFontSize && finalFontSize <= MIN_FONT_SIZE)}
                                    className="w-7 h-7 flex items-center justify-center bg-neutral-200 text-black font-bold rounded-sm hover:bg-neutral-300 disabled:bg-neutral-100 disabled:text-black/40 disabled:cursor-not-allowed transition-colors"
                                    aria-label="减小字号"
                                >-</button>
                                <span className="text-sm font-medium text-black w-16 text-center tabular-nums">
                                    {finalFontSize ? `${finalFontSize.toFixed(1)}pt` : '-'}
                                </span>
                                <button
                                    onClick={() => adjustFontSize(FONT_STEP)}
                                    disabled={!formattedHtml || isLoading || (finalFontSize && finalFontSize >= MAX_FONT_SIZE)}
                                     className="w-7 h-7 flex items-center justify-center bg-neutral-200 text-black font-bold rounded-sm hover:bg-neutral-300 disabled:bg-neutral-100 disabled:text-black/40 disabled:cursor-not-allowed transition-colors"
                                    aria-label="增大字号"
                                >+</button>
                                <div className="w-px h-6 bg-neutral-200 mx-2"></div>
                                <button 
                                    onClick={handlePrint} 
                                    disabled={!formattedHtml || isLoading}
                                    className="bg-black text-white font-bold py-1.5 px-4 rounded-sm hover:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:ring-offset-2 transition-colors duration-200 disabled:bg-neutral-400 disabled:cursor-not-allowed text-sm"
                                >
                                    打印
                                </button>
                            </div>
                        </div>
                        
                        {/* Screen-only Preview */}
                                <div className="no-print flex flex-col items-center gap-4">
                            {Array.from({ length: totalPages }).map((_, pageIndex) => (
                                <div key={pageIndex} className="bg-white shadow-xl preview-page" style={{width: `${PAGE_WIDTH_PX}px`, height: `${PAGE_HEIGHT_PX}px`}}>
                                    <div className="h-full flex" style={{padding: `${PAGE_PADDING_PX}px`, gap: `${COLUMN_GAP_PX}px`}}>
                                        {Array.from({ length: finalNumColumns }).map((_, colIndex) => {
                                            const overallColumnIndex = pageIndex * finalNumColumns + colIndex;
                                            const translateY = -COLUMN_HEIGHT_PX * overallColumnIndex;
                                            
                                            if (!formattedHtml && overallColumnIndex > 0) return <div key={colIndex} style={{width: `${columnWidth}px`}}/>;

                                            return (
                                                <div key={colIndex} style={{width: `${columnWidth}px`, height: `${COLUMN_HEIGHT_PX}px`, overflow: 'hidden'}}>
                                                    <div
                                                        className="prose-styles"
                                                        style={{
                                                            fontSize: finalFontSize ? `${finalFontSize}pt` : '12pt',
                                                            lineHeight: 1.6,
                                                            transition: 'font-size 0.3s ease-in-out',
                                                            transform: `translateY(${translateY}px)`,
                                                            width: `${columnWidth}px`
                                                        }}
                                                    dangerouslySetInnerHTML={{ __html: formattedHtml || (overallColumnIndex === 0 ? '<p class="text-black/40 pt-10">点击“智能排版”后，这里将显示预览。</p>' : '') }}
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                     </div>
                </div>
            </main>
        </div>
    );
};

export default App;
