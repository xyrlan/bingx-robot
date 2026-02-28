interface FormErrorProps {
  message?: string;
  variant?: 'danger' | 'warning';
}

export function FormError({ message, variant = 'danger' }: FormErrorProps) {
  if (!message) return null;

  const variantStyles = {
    danger: 'bg-danger/10 border-danger text-danger',
    warning: 'bg-warning/10 border-warning text-warning',
  };

  return (
    <div className={`mb-4 p-3 border rounded-lg ${variantStyles[variant]}`}>
      <p className="text-sm">{message}</p>
    </div>
  );
}
