import PoolPage from './components/PoolPage';
import ConfigManager from './components/ConfigManager';
import { createHashRouter, Navigate } from 'react-router-dom';

export default createHashRouter([
  { path: '/rotation', element: <PoolPage /> },
  { path: '/manage', element: <ConfigManager /> },
  {
    path: '/',
    element: <Navigate replace to='/manage' />
  },
  {
    path: '*',
    element: <Navigate replace to='/manage' />
  }
]);
