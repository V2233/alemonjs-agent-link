import { createHashRouter, Navigate } from 'react-router-dom';

export default createHashRouter([
  {
    path: '/',
    element: <Navigate replace to='/manage' />
  },
  {
    path: '*',
    element: <Navigate replace to='/manage' />
  }
]);
