// The annotation overlay's page (features/browser-annotate.md 계약: 주석 화면의 자리). The desktop
// loads it from corral-overlay://overlay/annotate.html into a transparent view over the browser
// tab's page; it talks only through window.corralAnnotate and draws nothing until the app page's
// first context arrives.
import '@corral/react/fonts.css';
import './annotate.css';
import { createRoot } from 'react-dom/client';
import { AnnotateApp } from './AnnotateApp.tsx';
import { annotateBridge } from './bridge.ts';

const root = document.getElementById('root');
const bridge = annotateBridge();
if (root && bridge) createRoot(root).render(<AnnotateApp bridge={bridge} />);
