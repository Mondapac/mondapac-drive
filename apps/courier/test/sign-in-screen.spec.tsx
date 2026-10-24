import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { SignInScreen } from '../src/screens/SignInScreen';
import { createHarness, renderWith } from './render';

const EMAIL = 'Email';
const PASSWORD = 'Password';

it('signs in with email and password and keeps the session', async () => {
  const harness = await createHarness();
  await harness.storage.clear();
  const signIn = jest.spyOn(harness.api, 'signIn');
  await renderWith(harness, <SignInScreen />);

  expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  await fireEvent.changeText(screen.getByLabelText(EMAIL), ' courier@example.test ');
  await fireEvent.changeText(screen.getByLabelText(PASSWORD), 'secret-1');
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

  await waitFor(() => expect(harness.stored()).not.toBeNull());
  expect(signIn).toHaveBeenCalledWith({ email: 'courier@example.test', password: 'secret-1' });
});

it('says when the credentials are wrong and clears the password', async () => {
  const harness = await createHarness();
  await harness.storage.clear();
  await renderWith(harness, <SignInScreen />);

  await fireEvent.changeText(screen.getByLabelText(EMAIL), 'courier@example.test');
  await fireEvent.changeText(screen.getByLabelText(PASSWORD), harness.mock.inspect.wrongPassword);
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

  await screen.findByText('The email or password is not right.');
  expect(screen.getByLabelText(PASSWORD).props.value).toBe('');
  expect(harness.stored()).toBeNull();
});
