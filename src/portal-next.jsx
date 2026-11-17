import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import PortalNextApp from './portal-next/PortalNextApp.jsx';

const el = document.getElementById('root');
createRoot(el).render(<PortalNextApp />);
