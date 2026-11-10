import { UiHostProvider } from '@delta/ui/host'
import App from './App'
import LookupApp from './LookupApp'
import { desktopHost } from './desktop-host'

function Root(): React.JSX.Element {
  const isLookup = typeof window !== 'undefined' && window.location.search.includes('role=lookup')

  return <UiHostProvider host={desktopHost}>{isLookup ? <LookupApp /> : <App />}</UiHostProvider>
}

export default Root
