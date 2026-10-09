import $ from 'jquery';
$('#mount').append('<form><label for="user">Username</label><input id="user" autocomplete="username"><label for="pass">Password</label><input id="pass" type="password" autocomplete="current-password"></form>');
window.frameworkState = {user:'',pass:''};
$('input').on('input change',function(){window.frameworkState[this.id] = $(this).val();});
$('form').on('submit',event=>event.preventDefault());
