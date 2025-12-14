import React, { useState, useRef, useCallback, useEffect } from 'react';
import { marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';
// @ts-ignore
import katex from 'katex';
// @ts-ignore
import JSZip from 'jszip';
// @ts-ignore
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
// @ts-ignore
import pdfjsWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
// @ts-ignore
import * as mammoth from 'mammoth';

// --- Constants ---
const A4_WIDTH_PT = 595; // Standard A4 width in points (72dpi)
const A4_HEIGHT_PT = 842; // Standard A4 height in points (72dpi)
const PAGE_PADDING_PT = 40; // 40pt padding
const COLUMN_GAP_PT = 10; // Space between columns (pt)

const MAX_FONT_SIZE = 16;
const MIN_FONT_SIZE = 2;
const FONT_STEP = 0.1;

const PT_TO_PX = 96 / 72; // CSS 1pt = 1/72in, 1px = 1/96in
const ptToPx = (pt: number) => pt * PT_TO_PX;

const PAGE_PADDING_PX = ptToPx(PAGE_PADDING_PT);
const COLUMN_GAP_PX = ptToPx(COLUMN_GAP_PT);

// Helper function to get page dimensions based on orientation
const getPageDimensions = (orientation: 'portrait' | 'landscape') => {
    const pageWidthPt = orientation === 'portrait' ? A4_WIDTH_PT : A4_HEIGHT_PT;
    const pageHeightPt = orientation === 'portrait' ? A4_HEIGHT_PT : A4_WIDTH_PT;
    const columnHeightPt = pageHeightPt - (PAGE_PADDING_PT * 2);
    
    return {
        pageWidthPt,
        pageHeightPt,
        columnHeightPt,
        pageWidthPx: ptToPx(pageWidthPt),
        pageHeightPx: ptToPx(pageHeightPt),
        columnHeightPx: ptToPx(columnHeightPt)
    };
};

// 高 DPI 导出参数
const EXPORT_DPI = 300; // 240~300 DPI 皆可，这里默认 300DPI
const EXPORT_IMAGE_QUALITY = 0.92; // JPEG 质量（0~1）

const DEFAULT_MARKDOWN = `# Markdown 页面适配器 (自动布局版)

这是一个智能排版工具，旨在帮助您将 Markdown 文本完美地排入两页 A4 纸中。

## 如何使用

1.  **输入内容**: 在编辑器中粘贴或输入您的 Markdown 文本。
2.  **点击排版**: 点击"智能排版"按钮。
3.  **预览结果**: 系统会自动寻找最佳布局（优先采用更多分栏，其次缩小字号），并在右侧预览区域展示结果。
4.  **微调字号**: 您可以使用预览上方的 +/- 按钮微调最终的字体大小。

## 功能特性

*   **自动字号调整**: 从 ${MAX_FONT_SIZE}pt 开始，逐步减小字号，直到内容适配。
*   **智能多栏布局**: 自动选择 1 到 4 栏的最佳布局以容纳内容。
*   **保留格式**: 支持所有标准的 Markdown 语法，如标题、列表、粗体、斜体等。
*   **LaTeX 公式支持**: 使用 $E=mc^2$ 行内公式，或 $$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$ 块级公式。
*   **打印友好**: 您可以直接使用浏览器的打印功能打印预览的页面。

---

> 如果文本内容过多，即使调整到最小字号（${MIN_FONT_SIZE}pt）和最密集的布局也无法容纳在两页内，系统会给出提示。

## LaTeX 示例

行内公式：质能方程 $E = mc^2$，欧拉公式 $e^{i\\pi} + 1 = 0$

块级公式：
$$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$

$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$

现在，请尝试粘贴您自己的内容！
`;

// --- LaTeX Rendering Helper ---
const renderLatex = (latex: string, displayMode: boolean): string => {
    try {
        return katex.renderToString(latex, {
            displayMode,
            throwOnError: false,
            output: 'html',
            strict: false
        });
    } catch (e) {
        console.error('KaTeX rendering error:', e);
        return `<span class="katex-error" style="color: red;">${displayMode ? '$$' : '$'}${latex}${displayMode ? '$$' : '$'}</span>`;
    }
};

// Process LaTeX in text: handles both $...$ (inline) and $$...$$ (block)
const processLatex = (text: string): string => {
    // First, handle block-level LaTeX ($$...$$)
    // Using a placeholder approach to avoid nested replacements
    const blockPlaceholders: string[] = [];
    let processed = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) => {
        const rendered = renderLatex(latex.trim(), true);
        const placeholder = `%%BLOCK_LATEX_${blockPlaceholders.length}%%`;
        blockPlaceholders.push(`<div class="katex-display">${rendered}</div>`);
        return placeholder;
    });
    
    // Then handle inline LaTeX ($...$), but not escaped \$ or already processed
    const inlinePlaceholders: string[] = [];
    processed = processed.replace(/(?<!\\)\$([^\$\n]+?)\$/g, (_, latex) => {
        const rendered = renderLatex(latex.trim(), false);
        const placeholder = `%%INLINE_LATEX_${inlinePlaceholders.length}%%`;
        inlinePlaceholders.push(rendered);
        return placeholder;
    });
    
    // Restore block placeholders
    blockPlaceholders.forEach((html, i) => {
        processed = processed.replace(`%%BLOCK_LATEX_${i}%%`, html);
    });
    
    // Restore inline placeholders
    inlinePlaceholders.forEach((html, i) => {
        processed = processed.replace(`%%INLINE_LATEX_${i}%%`, html);
    });
    
    return processed;
};

// Configure DOMPurify to allow KaTeX elements
const configureDOMPurify = () => {
    // Add KaTeX-specific tags and attributes to whitelist
    DOMPurify.addHook('uponSanitizeElement', (node, data) => {
        if (data.tagName === 'annotation') {
            // Allow annotation elements used by KaTeX
            return;
        }
    });
    
    // Allow SVG and MathML elements that KaTeX may use
    const ALLOWED_TAGS = [
        'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext',
        'annotation', 'annotation-xml', 'mspace', 'mfrac', 'msqrt',
        'mroot', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover',
        'mtable', 'mtr', 'mtd', 'mlabeledtr', 'mmultiscripts', 'mprescripts',
        'none', 'menclose', 'mstyle', 'mpadded', 'mphantom', 'mglyph',
        'svg', 'line', 'path', 'g', 'rect', 'circle', 'ellipse', 'polygon',
        'polyline', 'text', 'tspan', 'image', 'use', 'defs', 'clipPath',
        'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'stop'
    ];
    
    const ALLOWED_ATTR = [
        'class', 'style', 'href', 'xmlns', 'mathvariant', 'encoding',
        'displaystyle', 'scriptlevel', 'lspace', 'rspace', 'stretchy',
        'symmetric', 'maxsize', 'minsize', 'largeop', 'movablelimits',
        'accent', 'accentunder', 'linebreak', 'lineleading', 'linebreakstyle',
        'linebreakmultchar', 'indentalign', 'indentshift', 'indenttarget',
        'indentalignfirst', 'indentshiftfirst', 'indentalignlast', 'indentshiftlast',
        'depth', 'height', 'width', 'rowalign', 'columnalign', 'columnwidth',
        'groupalign', 'alignmentscope', 'rowspacing', 'columnspacing', 'rowlines',
        'columnlines', 'frame', 'framespacing', 'equalrows', 'equalcolumns',
        'side', 'minlabelspacing', 'rowspan', 'columnspan', 'data-mml-node',
        'd', 'fill', 'stroke', 'stroke-width', 'viewBox', 'preserveAspectRatio',
        'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
        'transform', 'opacity', 'font-size', 'text-anchor', 'dominant-baseline'
    ];
    
    return { ALLOWED_TAGS, ALLOWED_ATTR };
};

const domPurifyConfig = configureDOMPurify();

// 固定系统提示词（只读），用户的自定义指令将拼接在末尾 {{USER_CUSTOM_PROMPT}} 位置
const BASE_SYSTEM_PROMPT = [
'# 角色',
'你是一个 Markdown 速查表生成器。你的唯一功能是将原始文本转换成一个简洁、结构清晰的 Markdown 速查表。你是一个文本处理引擎，而不是一个对话式AI。',
'',
'# 核心规则',
'1.  **首要目标**：提取关键信息（如定义、公式、概念、定理），并将其格式化为一个干净的 Markdown 文档。',
'',
'2.  **格式化要求**：',
'    - 使用 `#`、`##`、`###` 作为各级标题。',
'    - 使用无序列表 (`- `) 来罗列要点。',
'    - 使用粗体 (`**文字**`) 来强调关键词。',
'    - 使用行内代码块 (`` `公式` ``) 来包裹所有公式、方程和代码，使其突出显示。',
'',
'3.  **严格输出协议**：',
'    - **你的全部回答必须且只能是 Markdown 内容本身。**',
'    - **禁止**输出任何引导性语句（例如，“这是您需要的速查表：”）。',
'    - **禁止**输出任何总结性话语（例如，“希望这能帮到您。”）。',
'    - 你输出的第一个字符必须是 Markdown 格式化字符（如 `#` 或 `-`），前面不能有任何文字或空格。',
'',
'# 用户的自定义指令',
'{{USER_CUSTOM_PROMPT}}',
].join('\\n');


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
    const [pageOrientation, setPageOrientation] = useState<'portrait' | 'landscape'>('portrait');
    const [previewWindow, setPreviewWindow] = useState<Window | null>(null);
    
    // Get current page dimensions based on orientation
    const pageDims = getPageDimensions(pageOrientation);

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
    // 自定义指令（仅用户部分，系统提示词固定）
    const [aiUserPrompt, setAiUserPrompt] = useState<string>(() => localStorage.getItem('ai_user_prompt') || '');
    const [isPromptModalOpen, setIsPromptModalOpen] = useState<boolean>(false);
    const [promptDraft, setPromptDraft] = useState<string>(aiUserPrompt);
    
    const measurementRef = useRef<HTMLDivElement>(null);

    // Calculate pages when content or settings change
    const calculatePages = useCallback(async (html: string, fontSize: number, numCols: number, dims: ReturnType<typeof getPageDimensions>): Promise<number> => {
        if (!html || !fontSize || !measurementRef.current) {
            return 2;
        }

        const container = measurementRef.current;
        container.innerHTML = html;
        const currentColumnWidthPt = (dims.pageWidthPt - (PAGE_PADDING_PT * 2) - (COLUMN_GAP_PT * (numCols - 1))) / numCols;
        const currentColumnWidthPx = ptToPx(currentColumnWidthPt);
        
        container.style.width = `${currentColumnWidthPx}px`;
        container.style.fontSize = `${fontSize}pt`;
        
        await new Promise(resolve => requestAnimationFrame(resolve));

        const totalContentHeightPx = container.scrollHeight;
        const heightPerColumnPx = dims.columnHeightPx;
        
        const totalColumnUnits = Math.ceil(totalContentHeightPx / heightPerColumnPx);
        const numPages = Math.ceil(totalColumnUnits / numCols);

        container.innerHTML = '';
        return numPages > 0 ? numPages : 1;
    }, []);

    useEffect(() => {
        const updatePages = async () => {
            if (!formattedHtml || !finalFontSize) {
                setTotalPages(2);
                return;
            }
            const pages = await calculatePages(formattedHtml, finalFontSize, finalNumColumns, pageDims);
            setTotalPages(pages);
        };
        updatePages();
    }, [formattedHtml, finalFontSize, finalNumColumns, pageDims, calculatePages]);

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
    // 持久化自定义指令（仅用户部分）
    useEffect(() => {
        localStorage.setItem('ai_user_prompt', aiUserPrompt);
    }, [aiUserPrompt]);

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
            // 组装系统提示词 + 用户自定义指令 + 解析说明
            const baseSystem = BASE_SYSTEM_PROMPT;
            const fileTypeLabel: Record<string, string> = { pdf: 'PDF', docx: 'DOCX', pptx: 'PPTX', md: 'Markdown', txt: 'TXT' };
            const typesIncluded = Array.from(new Set(aiFiles
                .map(f => (f.name.split('.').pop()?.toLowerCase() || ''))
                .filter(Boolean)
                .map(ext => fileTypeLabel[ext] || ext.toUpperCase())));
            const sourceNote = typesIncluded.length > 0
                ? `注意：本次材料来自本地解析（包含：${typesIncluded.join(', ')}），可能存在格式/布局/公式渲染等细节丢失或换行错乱。请在总结时尽量修复明显格式问题，并对不确定处标注“可能不完整”。`
                : `注意：材料主要来自纯文本输入。`;
            const systemWithUser = baseSystem.replace('{{USER_CUSTOM_PROMPT}}', (aiUserPrompt?.trim() || '（无）'));
            const SYSTEM_PROMPT = `${systemWithUser}\n\n（系统信息）解析说明：${sourceNote}`;

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
    }, [aiSourceText, aiApiKey, aiSelectedModel, aiBaseUrl, callChatCompletions, aiFiles, aiUserPrompt]);

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

        // Process LaTeX before markdown parsing
        const markdownWithLatex = processLatex(markdown);
        const unsafeHtml = await marked.parse(markdownWithLatex);
        // Use extended config to allow KaTeX elements
        const cleanHtml = DOMPurify.sanitize(unsafeHtml, {
            ADD_TAGS: domPurifyConfig.ALLOWED_TAGS,
            ADD_ATTR: domPurifyConfig.ALLOWED_ATTR,
            ALLOW_DATA_ATTR: true
        });
        container.innerHTML = cleanHtml;

        // Get current dimensions based on orientation
        const dims = getPageDimensions(pageOrientation);
        
        // Determine columns to try: auto (4 -> 1) or user-selected fixed column count
        const columnsToTry = columnOption === 'auto' ? [4, 3, 2, 1] : [parseInt(columnOption, 10)];
        for (const numCols of columnsToTry) {
            const currentColumnWidthPt = (dims.pageWidthPt - (PAGE_PADDING_PT * 2) - (COLUMN_GAP_PT * (numCols - 1))) / numCols;
            // 两页高度阈值（px）
            const totalAvailableHeightPx = dims.columnHeightPx * 2 * numCols;
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
    }, [markdown, columnOption, pageOrientation]);

    // When column option changes, only update column count; keep current font size.
    useEffect(() => {
        if (!formattedHtml) return;
        if (columnOption === 'auto') return; // Auto layout only when clicking "智能排版"
        const chosenCols = parseInt(columnOption, 10);
        if (Number.isFinite(chosenCols)) {
            setFinalNumColumns(chosenCols);
        }
    }, [columnOption, formattedHtml]);

    // Open preview in a new popup window
    const openPreviewWindow = useCallback(async () => {
        if (!formattedHtml || !finalFontSize) {
            setStatusMessage({ type: 'error', text: '请先点击"智能排版"生成预览内容。' });
            return;
        }

        // Close existing preview window if open
        if (previewWindow && !previewWindow.closed) {
            previewWindow.focus();
            return;
        }

        const dims = getPageDimensions(pageOrientation);
        const pages = await calculatePages(formattedHtml, finalFontSize, finalNumColumns, dims);
        const columnWidthPx = (dims.pageWidthPx - (PAGE_PADDING_PX * 2) - (COLUMN_GAP_PX * (finalNumColumns - 1))) / finalNumColumns;

        // Generate pages HTML
        const pagesHtml = Array.from({ length: pages }).map((_, pageIndex) => {
            const columnsHtml = Array.from({ length: finalNumColumns }).map((_, colIndex) => {
                const overallColumnIndex = pageIndex * finalNumColumns + colIndex;
                const translateY = -dims.columnHeightPx * overallColumnIndex;
                return `
                    <div style="width: ${columnWidthPx}px; height: ${dims.columnHeightPx}px; overflow: hidden;">
                        <div class="prose-styles" style="font-size: ${finalFontSize}pt; line-height: 1.6; transform: translateY(${translateY}px); width: ${columnWidthPx}px;">
                            ${formattedHtml}
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div class="preview-page" style="width: ${dims.pageWidthPx}px; height: ${dims.pageHeightPx}px; background: white; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); margin-bottom: 16px;">
                    <div style="height: 100%; display: flex; padding: ${PAGE_PADDING_PX}px; gap: ${COLUMN_GAP_PX}px;">
                        ${columnsHtml}
                    </div>
                </div>
            `;
        }).join('');

        const windowWidth = Math.min(dims.pageWidthPx + 100, screen.availWidth - 100);
        const windowHeight = Math.min(dims.pageHeightPx + 200, screen.availHeight - 100);

        const newWindow = window.open('', 'preview', `width=${windowWidth},height=${windowHeight},scrollbars=yes,resizable=yes`);
        if (!newWindow) {
            setStatusMessage({ type: 'error', text: '无法打开预览窗口，请检查浏览器是否阻止了弹出窗口。' });
            return;
        }

        setPreviewWindow(newWindow);

        const pageSize = pageOrientation === 'portrait' ? 'A4' : 'A4 landscape';
        
        newWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>排版预览 - ${pages}页 / ${finalNumColumns}栏</title>
                <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" crossorigin="anonymous">
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        background: #f5f5f5;
                        padding: 20px;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                    }
                    .toolbar {
                        position: sticky;
                        top: 0;
                        background: white;
                        padding: 12px 20px;
                        border-radius: 4px;
                        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                        margin-bottom: 20px;
                        display: flex;
                        align-items: center;
                        gap: 16px;
                        flex-wrap: wrap;
                        z-index: 100;
                    }
                    .toolbar label { font-size: 14px; color: #666; }
                    .toolbar select, .toolbar button {
                        padding: 6px 12px;
                        border: 1px solid #ddd;
                        border-radius: 4px;
                        font-size: 14px;
                        background: white;
                        cursor: pointer;
                    }
                    .toolbar select:focus, .toolbar button:focus {
                        outline: none;
                        border-color: #333;
                    }
                    .toolbar button:hover { background: #f0f0f0; }
                    .toolbar .btn-primary {
                        background: #000;
                        color: white;
                        border-color: #000;
                    }
                    .toolbar .btn-primary:hover { background: #333; }
                    .toolbar .font-controls {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .toolbar .font-btn {
                        width: 28px;
                        height: 28px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-weight: bold;
                    }
                    .toolbar .font-size {
                        min-width: 60px;
                        text-align: center;
                        font-family: monospace;
                    }
                    .preview-container {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                    }
                    .prose-styles h1, .prose-styles h2, .prose-styles h3, .prose-styles h4, .prose-styles h5, .prose-styles h6 { color: #000 !important; font-weight: 700 !important; }
                    .prose-styles p, .prose-styles li { color: #000 !important; }
                    .prose-styles a { color: #000 !important; text-decoration: underline !important; }
                    .prose-styles blockquote { border-left-color: rgba(0,0,0,0.25) !important; color: rgba(0,0,0,0.85) !important; border-left-width: 4px !important; padding-left: 1em !important; }
                    .prose-styles code { color: #000 !important; background-color: #f8fafc !important; padding: 0.1em 0.3em !important; border-radius: 2px !important; }
                    .prose-styles pre { background-color: #f5f5f5 !important; color: #000 !important; padding: 1em !important; border-radius: 2px !important; }
                    .prose-styles .katex { font-size: 1em !important; }
                    .prose-styles .katex-display { display: block !important; margin: 0.5em 0 !important; text-align: center !important; overflow-x: auto !important; overflow-y: hidden !important; }
                    .prose-styles .katex-display > .katex { display: inline-block !important; text-align: initial !important; }
                    .prose-styles .katex-error { color: #cc0000 !important; font-family: monospace !important; white-space: pre-wrap !important; }
                    @media print {
                        body { background: white; padding: 0; }
                        .toolbar { display: none !important; }
                        .preview-page { box-shadow: none !important; margin-bottom: 0 !important; page-break-after: always; }
                        @page { size: ${pageSize}; margin: 0; }
                    }
                </style>
            </head>
            <body>
                <div class="toolbar">
                    <label>纸张方向:</label>
                    <select id="orientation">
                        <option value="portrait" ${pageOrientation === 'portrait' ? 'selected' : ''}>竖向</option>
                        <option value="landscape" ${pageOrientation === 'landscape' ? 'selected' : ''}>横向</option>
                    </select>
                    <label>分栏:</label>
                    <select id="columns">
                        <option value="1" ${finalNumColumns === 1 ? 'selected' : ''}>1栏</option>
                        <option value="2" ${finalNumColumns === 2 ? 'selected' : ''}>2栏</option>
                        <option value="3" ${finalNumColumns === 3 ? 'selected' : ''}>3栏</option>
                        <option value="4" ${finalNumColumns === 4 ? 'selected' : ''}>4栏</option>
                    </select>
                    <div class="font-controls">
                        <label>字号:</label>
                        <button class="font-btn" id="fontMinus">−</button>
                        <span class="font-size" id="fontSizeDisplay">${finalFontSize.toFixed(1)}pt</span>
                        <button class="font-btn" id="fontPlus">+</button>
                    </div>
                    <button class="btn-primary" id="printBtn">打印 / 导出PDF</button>
                </div>
                <div class="preview-container" id="previewContainer">
                    ${pagesHtml}
                </div>
                <script>
                    const EXPORT_DPI = 300;
                    const EXPORT_IMAGE_QUALITY = 0.92;
                    const PAGE_PADDING_PX = ${PAGE_PADDING_PX};
                    const COLUMN_GAP_PX = ${COLUMN_GAP_PX};
                    const MIN_FONT_SIZE = ${MIN_FONT_SIZE};
                    const MAX_FONT_SIZE = ${MAX_FONT_SIZE};
                    const FONT_STEP = ${FONT_STEP};
                    
                    let currentOrientation = '${pageOrientation}';
                    let currentColumns = ${finalNumColumns};
                    let currentFontSize = ${finalFontSize};
                    const formattedHtml = ${JSON.stringify(formattedHtml)};
                    
                    function getPageDimensions(orientation) {
                        const A4_WIDTH_PT = 595;
                        const A4_HEIGHT_PT = 842;
                        const PAGE_PADDING_PT = 40;
                        const PT_TO_PX = 96 / 72;
                        const pageWidthPt = orientation === 'portrait' ? A4_WIDTH_PT : A4_HEIGHT_PT;
                        const pageHeightPt = orientation === 'portrait' ? A4_HEIGHT_PT : A4_WIDTH_PT;
                        const columnHeightPt = pageHeightPt - (PAGE_PADDING_PT * 2);
                        return {
                            pageWidthPt,
                            pageHeightPt,
                            columnHeightPt,
                            pageWidthPx: pageWidthPt * PT_TO_PX,
                            pageHeightPx: pageHeightPt * PT_TO_PX,
                            columnHeightPx: columnHeightPt * PT_TO_PX
                        };
                    }
                    
                    function renderPreview() {
                        const dims = getPageDimensions(currentOrientation);
                        const columnWidthPx = (dims.pageWidthPx - (PAGE_PADDING_PX * 2) - (COLUMN_GAP_PX * (currentColumns - 1))) / currentColumns;
                        
                        // Calculate pages needed
                        const tempDiv = document.createElement('div');
                        tempDiv.style.cssText = 'position:absolute;visibility:hidden;width:' + columnWidthPx + 'px;font-size:' + currentFontSize + 'pt;line-height:1.6';
                        tempDiv.className = 'prose-styles';
                        tempDiv.innerHTML = formattedHtml;
                        document.body.appendChild(tempDiv);
                        const totalHeight = tempDiv.scrollHeight;
                        document.body.removeChild(tempDiv);
                        
                        const totalColumnUnits = Math.ceil(totalHeight / dims.columnHeightPx);
                        const numPages = Math.max(1, Math.ceil(totalColumnUnits / currentColumns));
                        
                        document.title = '排版预览 - ' + numPages + '页 / ' + currentColumns + '栏';
                        
                        let pagesHtml = '';
                        for (let pageIndex = 0; pageIndex < numPages; pageIndex++) {
                            let columnsHtml = '';
                            for (let colIndex = 0; colIndex < currentColumns; colIndex++) {
                                const overallColumnIndex = pageIndex * currentColumns + colIndex;
                                const translateY = -dims.columnHeightPx * overallColumnIndex;
                                columnsHtml += '<div style="width:' + columnWidthPx + 'px;height:' + dims.columnHeightPx + 'px;overflow:hidden;">' +
                                    '<div class="prose-styles" style="font-size:' + currentFontSize + 'pt;line-height:1.6;transform:translateY(' + translateY + 'px);width:' + columnWidthPx + 'px;">' +
                                    formattedHtml +
                                    '</div></div>';
                            }
                            pagesHtml += '<div class="preview-page" style="width:' + dims.pageWidthPx + 'px;height:' + dims.pageHeightPx + 'px;background:white;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);margin-bottom:16px;">' +
                                '<div style="height:100%;display:flex;padding:' + PAGE_PADDING_PX + 'px;gap:' + COLUMN_GAP_PX + 'px;">' +
                                columnsHtml +
                                '</div></div>';
                        }
                        document.getElementById('previewContainer').innerHTML = pagesHtml;
                    }
                    
                    document.getElementById('orientation').addEventListener('change', function(e) {
                        currentOrientation = e.target.value;
                        renderPreview();
                    });
                    
                    document.getElementById('columns').addEventListener('change', function(e) {
                        currentColumns = parseInt(e.target.value);
                        renderPreview();
                    });
                    
                    document.getElementById('fontMinus').addEventListener('click', function() {
                        if (currentFontSize > MIN_FONT_SIZE) {
                            currentFontSize = Math.max(MIN_FONT_SIZE, currentFontSize - FONT_STEP);
                            document.getElementById('fontSizeDisplay').textContent = currentFontSize.toFixed(1) + 'pt';
                            renderPreview();
                        }
                    });
                    
                    document.getElementById('fontPlus').addEventListener('click', function() {
                        if (currentFontSize < MAX_FONT_SIZE) {
                            currentFontSize = Math.min(MAX_FONT_SIZE, currentFontSize + FONT_STEP);
                            document.getElementById('fontSizeDisplay').textContent = currentFontSize.toFixed(1) + 'pt';
                            renderPreview();
                        }
                    });
                    
                    document.getElementById('printBtn').addEventListener('click', function() {
                        window.print();
                    });
                </script>
            </body>
            </html>
        `);
        newWindow.document.close();
    }, [formattedHtml, finalFontSize, finalNumColumns, pageOrientation, previewWindow, calculatePages]);

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
                
                /* KaTeX styles */
                .prose-styles .katex { font-size: 1em !important; }
                .prose-styles .katex-display { display: block !important; margin: 0.5em 0 !important; text-align: center !important; overflow-x: auto !important; overflow-y: hidden !important; }
                .prose-styles .katex-display > .katex { display: inline-block !important; text-align: initial !important; }
                .prose-styles .katex-error { color: #cc0000 !important; font-family: monospace !important; white-space: pre-wrap !important; }
                .prose-styles .katex .base { display: inline-block !important; }
                .prose-styles .katex .strut { display: inline-block !important; }
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

            <main className="container mx-auto p-4 md:p-8 max-w-4xl">
                <div className="flex flex-col no-print">
                    {/* AI 知识点总结卡片 */}
                    <div className="bg-white rounded-sm shadow-md mb-6">
                        <div className="p-4 border-b border-neutral-200 flex items-center justify-between">
                            <h2 className="text-xl font-semibold text-black">AI 知识点总结（OpenAI）</h2>
                            <button
                                onClick={() => { setPromptDraft(aiUserPrompt); setIsPromptModalOpen(true); }}
                                className="bg-black text-white font-bold py-2 px-4 rounded-sm hover:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-800 text-sm no-print"
                            >
                                自定义指令
                            </button>
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
                        <div className="p-4 border-b border-neutral-200 flex items-center justify-between flex-wrap gap-2">
                            <h2 className="text-xl font-semibold text-black">输入 Markdown 内容</h2>
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm text-black/60">纸张方向:</span>
                                <select
                                    value={pageOrientation}
                                    onChange={(e) => setPageOrientation(e.target.value as 'portrait' | 'landscape')}
                                    className="text-sm border border-neutral-300 rounded-sm px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:border-neutral-800"
                                    aria-label="选择纸张方向"
                                >
                                    <option value="portrait">竖向</option>
                                    <option value="landscape">横向</option>
                                </select>
                                <span className="text-sm text-black/60 ml-2">分栏:</span>
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
                                <button
                                    onClick={handleFormat}
                                    disabled={isLoading}
                                    className="ml-2 bg-black text-white font-bold py-2 px-6 rounded-sm hover:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-800 transition-colors duration-200 disabled:bg-neutral-400 disabled:cursor-not-allowed text-sm no-print"
                                >
                                    {isLoading ? '排版中...' : '智能排版'}
                                </button>
                                <button
                                    onClick={openPreviewWindow}
                                    disabled={!formattedHtml || isLoading}
                                    className="bg-neutral-700 text-white font-bold py-2 px-6 rounded-sm hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-600 transition-colors duration-200 disabled:bg-neutral-400 disabled:cursor-not-allowed text-sm no-print"
                                >
                                    预览
                                </button>
                            </div>
                        </div>
                        <textarea
                            value={markdown}
                            onChange={(e) => setMarkdown(e.target.value)}
                            className="w-full h-full flex-grow p-4 border-0 resize-none focus:ring-0 text-sm leading-6"
                            placeholder="在此处输入或粘贴您的 Markdown..."
                            style={{minHeight: '50vh'}}
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
            </main>

            {/* 自定义指令弹窗 */}
            {isPromptModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 no-print">
                    <div className="bg-white rounded-sm shadow-lg w-full max-w-3xl p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-lg font-semibold text-black">编辑自定义指令</h3>
                            <button
                                onClick={() => setIsPromptModalOpen(false)}
                                className="text-black/60 hover:text-black text-sm"
                                aria-label="关闭"
                            >
                                ✕
                            </button>
                        </div>
                        <div className="space-y-3">
                            <label className="block text-sm text-black/80 mb-1">用户的自定义指令</label>
                            <textarea
                                value={promptDraft}
                                onChange={(e) => setPromptDraft(e.target.value)}
                                className="w-full min-h-[220px] p-3 border border-neutral-300 rounded-sm text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:border-neutral-800"
                                placeholder="请输入补充给模型的偏好/风格/结构要求（会与系统提示词合并发送）"
                            />
                            <p className="mt-2 text-xs text-black/60">
                                说明：系统提示词不在界面展示，已内置。此处仅填写你额外的要求；保存后会本地持久化。
                            </p>
                        </div>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                onClick={() => setPromptDraft('')}
                                className="px-3 py-2 text-sm bg-neutral-200 rounded-sm hover:bg-neutral-300"
                            >
                                清空
                            </button>
                            <button
                                onClick={() => setIsPromptModalOpen(false)}
                                className="px-3 py-2 text-sm bg-neutral-200 rounded-sm hover:bg-neutral-300"
                            >
                                取消
                            </button>
                            <button
                                onClick={() => { setAiUserPrompt(promptDraft); setIsPromptModalOpen(false); }}
                                className="px-4 py-2 text-sm bg-black text-white rounded-sm hover:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-800"
                            >
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default App;
