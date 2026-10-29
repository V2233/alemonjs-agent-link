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
      { path: '/events', element: <EventsPage /> },
      { path: '/dictionary', element: <DictionaryPage /> },
      { path: '/personas', element: <ContentPage key='personas' kind='personas' /> },
      { path: '/knowledge', element: <ContentPage key='knowledge' kind='knowledge' /> },
      { path: '/work-model', element: <WorkModelPage /> },
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
