import { createFileRoute } from '@tanstack/react-router';
import { AuthForm } from '../account/AuthForm';

export const Route = createFileRoute('/register')({
  component: () => <AuthForm mode="register" />,
});
