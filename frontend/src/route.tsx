import ContentPage from './components/ContentPage';
import AdminLayout from './components/AdminLayout';
import PoolPage from './components/PoolPage';
import { createHashRouter, Navigate } from 'react-router-dom';

export default createHashRouter([
  {
    element: <AdminLayout />,
    children: [
      { path: '/personas', element: <ContentPage key='personas' kind='personas' /> },
      { path: '/knowledge', element: <ContentPage key='knowledge' kind='knowledge' /> },
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
