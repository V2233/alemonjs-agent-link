import SponsorsPage from './components/SponsorsPage';
import TokenUsagePage from './components/TokenUsagePage';
import ImagesPage from './components/ImagesPage';
import StickersPage from './components/StickersPage';
import SettingsPage from './components/SettingsPage';
import AdsPage from './components/AdsPage';
import HobbiesPage from './components/HobbiesPage';
import VoicesPage from './components/VoicesPage';
import OpinionsPage from './components/OpinionsPage';
import EventsPage from './components/EventsPage';
import WorkModelPage from './components/WorkModelPage';
import DictionaryPage from './components/DictionaryPage';
import ContentPage from './components/ContentPage';
import AdminLayout from './components/AdminLayout';
import PoolPage from './components/PoolPage';
import { createHashRouter, Navigate } from 'react-router-dom';

export default createHashRouter([
  {
    element: <AdminLayout />,
    children: [
      { path: '/settings', element: <SettingsPage /> },
      { path: '/ads', element: <AdsPage /> },
      { path: '/sponsors', element: <SponsorsPage /> },
      { path: '/hobbies', element: <HobbiesPage /> },
      { path: '/stickers', element: <StickersPage /> },
      { path: '/images', element: <ImagesPage /> },
      { path: '/voices', element: <VoicesPage /> },
      { path: '/opinions', element: <OpinionsPage /> },
      { path: '/events', element: <EventsPage /> },
      { path: '/dictionary', element: <DictionaryPage /> },
      { path: '/personas', element: <ContentPage key='personas' kind='personas' /> },
      { path: '/knowledge', element: <ContentPage key='knowledge' kind='knowledge' /> },
      { path: '/work-model', element: <WorkModelPage /> },
      { path: '/token-usage', element: <TokenUsagePage /> },
      { path: '/rotation', element: <PoolPage /> }
    ]
  },
  {
    path: '/',
    element: <Navigate replace to='/personas' />
  },
  {
    path: '*',
    element: <Navigate replace to='/personas' />
  }
]);
