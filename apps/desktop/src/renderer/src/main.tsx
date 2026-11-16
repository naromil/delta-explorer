import { isRenderWindow, startMaterialsRenderer } from './materials-render'

// The hidden render window draws PDFs and images for the main process and shows no UI.
if (isRenderWindow()) startMaterialsRenderer()
else void import('./app-entry')
